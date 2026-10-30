import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/log.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/models/network/endpoint_selection_diagnostics.model.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/backup/drift_backup.provider.dart';
import 'package:immich_mobile/providers/gallery_permission.provider.dart';
import 'package:immich_mobile/providers/infrastructure/memory.provider.dart';
import 'package:immich_mobile/providers/infrastructure/platform.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/permission.provider.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';
import 'package:immich_mobile/providers/websocket.provider.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:logging/logging.dart';

enum AppLifeCycleEnum { active, inactive, paused, resumed, detached, hidden }

Future<void> handoffAndroidBackupToBackground({
  required void Function() stopForegroundBackup,
  required Future<void> Function() runBackgroundBackupNow,
}) async {
  stopForegroundBackup();
  // Android unlocks the background engine and enqueues the worker atomically
  // in handoffToBackground. Keeping this to one platform call matters because the Dart
  // isolate may be suspended immediately after the hidden lifecycle event.
  await runBackgroundBackupNow();
}

class AndroidBackgroundHandoffCoordinator {
  Future<void>? _operation;

  Future<void> run(Future<void> Function() action) {
    final existing = _operation;
    if (existing != null) {
      return existing;
    }

    final operation = action();
    _operation = operation;
    operation.onError((_, _) {
      if (identical(_operation, operation)) {
        _operation = null;
      }
    });
    return operation;
  }

  void reset() => _operation = null;
}

Future<bool> runForegroundResumePipeline({
  required Future<void> Function() syncLocal,
  required Future<bool> Function() syncRemote,
  required Future<void> Function() reconcileCompletedUploads,
  required Future<void> Function() hashAssets,
  required Future<void> Function() resumeBackup,
  required void Function() onSyncComplete,
}) async {
  var syncSuccess = false;
  await Future.wait([syncLocal(), syncRemote().then((success) => syncSuccess = success)]);
  onSyncComplete();
  await hashAssets();
  if (syncSuccess) {
    await reconcileCompletedUploads();
    await resumeBackup();
  }
  return syncSuccess;
}

class AppLifeCycleNotifier extends StateNotifier<AppLifeCycleEnum> {
  final Ref _ref;
  bool _wasPaused = false;

  // Add operation coordination
  Completer<void>? _resumeOperation;
  Completer<void>? _pauseOperation;
  final AndroidBackgroundHandoffCoordinator _androidBackgroundHandoff = AndroidBackgroundHandoffCoordinator();

  final _log = Logger("AppLifeCycleNotifier");

  AppLifeCycleNotifier(this._ref) : super(AppLifeCycleEnum.active);

  AppLifeCycleEnum getAppState() {
    return state;
  }

  void handleAppResume() async {
    state = AppLifeCycleEnum.resumed;
    _androidBackgroundHandoff.reset();

    // Prevent overlapping resume operations
    if (_resumeOperation != null && !_resumeOperation!.isCompleted) {
      await _resumeOperation!.future;
      return;
    }

    // Cancel any ongoing pause operation
    if (_pauseOperation != null && !_pauseOperation!.isCompleted) {
      _pauseOperation!.complete();
    }

    _resumeOperation = Completer<void>();

    try {
      await _performResume();
    } catch (e, stackTrace) {
      _log.severe("Error during app resume", e, stackTrace);
    } finally {
      if (!_resumeOperation!.isCompleted) {
        _resumeOperation!.complete();
      }
      _resumeOperation = null;
    }
  }

  Future<void> _performResume() async {
    // no need to resume because app was never really paused
    if (!_wasPaused) {
      return;
    }
    _wasPaused = false;

    final isAuthenticated = _ref.read(authProvider).isAuthenticated;

    // Needs to be logged in
    if (isAuthenticated) {
      // switch endpoint if needed
      final endpoint = await _ref
          .read(authProvider.notifier)
          .setOpenApiServiceEndpoint(reason: EndpointSelectionReason.appResume);
      _log.info("Using server URL: $endpoint");

      await _ref.read(serverInfoProvider.notifier).getServerVersion();
    }

    _ref.read(websocketProvider.notifier).connect();
    await _handleBetaTimelineResume();

    await _ref.read(notificationPermissionProvider.notifier).getNotificationPermission();

    await _ref.read(galleryPermissionNotifier.notifier).getGalleryPermissionStatus();
  }

  Future<void> _safeRun(Future<void> action, String debugName) async {
    if (!_shouldContinueOperation()) {
      return;
    }

    try {
      await action;
    } catch (e, stackTrace) {
      _log.warning("Error during $debugName operation", e, stackTrace);
    }
  }

  Future<void> _handleBetaTimelineResume() async {
    unawaited(_ref.read(backgroundWorkerLockServiceProvider).lock());

    // Give isolates time to complete any ongoing database transactions
    await Future.delayed(const Duration(milliseconds: 500));

    final backgroundManager = _ref.read(backgroundSyncProvider);
    final isAlbumLinkedSyncEnable = _ref.read(appConfigProvider).backup.syncAlbums;

    try {
      await runForegroundResumePipeline(
        syncLocal: () => _safeRun(backgroundManager.syncLocal(full: CurrentPlatform.isAndroid), "syncLocal"),
        syncRemote: () async {
          var succeeded = false;
          await _safeRun(backgroundManager.syncRemote().then((value) => succeeded = value), "syncRemote");
          return succeeded;
        },
        reconcileCompletedUploads: () async {
          final currentUser = Store.tryGet(StoreKey.currentUser);
          if (currentUser != null) {
            await _ref.read(backgroundUploadServiceProvider).reconcileCompletedResumableUploads(currentUser.id);
          }
        },
        hashAssets: () => _safeRun(backgroundManager.hashAssets(), "hashAssets"),
        resumeBackup: _resumeBackup,
        onSyncComplete: () => _ref.invalidate(driftMemoryFutureProvider),
      );

      if (isAlbumLinkedSyncEnable) {
        await _safeRun(backgroundManager.syncLinkedAlbum(), "syncLinkedAlbum");
      }
    } catch (e, stackTrace) {
      _log.severe("Error during background sync", e, stackTrace);
    }
  }

  Future<void> _resumeBackup() async {
    final isEnableBackup = _ref.read(appConfigProvider).backup.enabled;

    if (isEnableBackup) {
      final currentUser = Store.tryGet(StoreKey.currentUser);
      if (currentUser != null) {
        await _safeRun(
          _ref.read(driftBackupProvider.notifier).startForegroundBackup(currentUser.id),
          "handleBackupResume",
        );
      }
    }
  }

  // Helper method to check if operations should continue
  bool _shouldContinueOperation() {
    return [AppLifeCycleEnum.resumed, AppLifeCycleEnum.active].contains(state) &&
        (_resumeOperation?.isCompleted == false || _resumeOperation == null);
  }

  void handleAppInactivity() {
    state = AppLifeCycleEnum.inactive;
    // do not stop/clean up anything on inactivity: issued on every orientation change
  }

  Future<void> handleAppPause() async {
    state = AppLifeCycleEnum.paused;
    _wasPaused = true;

    // Prevent overlapping pause operations
    if (_pauseOperation != null && !_pauseOperation!.isCompleted) {
      await _pauseOperation!.future;
      return;
    }

    // Cancel any ongoing resume operation
    if (_resumeOperation != null && !_resumeOperation!.isCompleted) {
      _resumeOperation!.complete();
    }

    _pauseOperation = Completer<void>();

    try {
      await _performPause();
    } catch (e, stackTrace) {
      _log.severe("Error during app pause", e, stackTrace);
    } finally {
      if (!_pauseOperation!.isCompleted) {
        _pauseOperation!.complete();
      }
      _pauseOperation = null;
    }
  }

  Future<void> _performPause() async {
    if (_ref.read(authProvider).isAuthenticated) {
      final backup = _ref.read(driftBackupProvider.notifier);
      final backgroundWorkerLock = _ref.read(backgroundWorkerLockServiceProvider);

      if (CurrentPlatform.isAndroid && _ref.read(appConfigProvider).backup.enabled) {
        await _handoffAndroidBackupToBackground();
      } else {
        backup.stopForegroundBackup();
        await backgroundWorkerLock.unlock();
      }

      _ref.read(websocketProvider.notifier).disconnect();
    } else {
      await _ref.read(backgroundWorkerLockServiceProvider).unlock();
    }

    await LogService.I.flush().catchError((_) {});
  }

  Future<void> handleAppDetached() async {
    state = AppLifeCycleEnum.detached;

    unawaited(_ref.read(backgroundWorkerLockServiceProvider).unlock());

    // Flush logs before closing database
    try {
      await LogService.I.flush();
    } catch (_) {}
  }

  void handleAppHidden() {
    state = AppLifeCycleEnum.hidden;
    _wasPaused = true;

    // Flutter synthesizes hidden before paused on Android. Some devices suspend
    // Dart before the later paused callback can finish, so hand off while this
    // callback is still guaranteed to run. The coordinator makes the subsequent
    // paused callback reuse the same operation instead of scheduling twice.
    if (CurrentPlatform.isAndroid &&
        _ref.read(authProvider).isAuthenticated &&
        _ref.read(appConfigProvider).backup.enabled) {
      unawaited(
        _handoffAndroidBackupToBackground().catchError((Object error, StackTrace stackTrace) {
          _log.severe("Error during app hidden background handoff", error, stackTrace);
        }),
      );
    }
  }

  Future<void> _handoffAndroidBackupToBackground() {
    return _androidBackgroundHandoff.run(
      () => handoffAndroidBackupToBackground(
        stopForegroundBackup: _ref.read(driftBackupProvider.notifier).stopForegroundBackup,
        runBackgroundBackupNow: _ref.read(backgroundWorkerFgServiceProvider).handoffToBackground,
      ),
    );
  }
}

final appStateProvider = StateNotifierProvider<AppLifeCycleNotifier, AppLifeCycleEnum>((ref) {
  return AppLifeCycleNotifier(ref);
});
