import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/sync_linked_album.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/extensions/translate_extensions.dart';
import 'package:immich_mobile/models/network/endpoint_selection_diagnostics.model.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/backup/backup_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/platform.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/platform/background_worker_api.g.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:immich_mobile/widgets/settings/setting_list_tile.dart';
import 'package:immich_mobile/widgets/settings/settings_sub_page_scaffold.dart';

class DriftBackupSettings extends ConsumerWidget {
  const DriftBackupSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SettingsSubPageScaffold(
      settings: [
        SettingGroupTitle(
          title: "network_requirements".t(context: context),
          icon: Icons.cell_tower,
        ),
        const _UseCellularForVideosButton(),
        const _UseCellularForPhotosButton(),
        if (CurrentPlatform.isAndroid) ...[
          const Divider(),
          SettingGroupTitle(
            title: "background_options".t(context: context),
            icon: Icons.charging_station_rounded,
          ),
          const _BackupOnlyWhenChargingButton(),
          const _BackupDelaySlider(),
          const _BackgroundBackupStatus(),
        ],
        const Divider(),
        SettingGroupTitle(
          title: "backup_albums_sync".t(context: context),
          icon: Icons.sync,
        ),
        const _AlbumSyncActionButton(),
      ],
    );
  }
}

class _BackgroundBackupStatus extends ConsumerStatefulWidget {
  const _BackgroundBackupStatus();

  @override
  ConsumerState<_BackgroundBackupStatus> createState() => _BackgroundBackupStatusState();
}

class _BackgroundBackupStatusState extends ConsumerState<_BackgroundBackupStatus> {
  late Future<BackgroundWorkerDiagnostics> _diagnostics;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _refresh();
    _refreshTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      if (mounted) {
        setState(_refresh);
      }
    });
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  void _refresh() {
    _diagnostics = ref.read(backgroundWorkerFgServiceProvider).getDiagnostics();
  }

  String _formatTimestamp(int? milliseconds) {
    if (milliseconds == null) {
      return 'Never';
    }
    return DateFormat.yMd().add_Hms().format(DateTime.fromMillisecondsSinceEpoch(milliseconds));
  }

  String _endpointDiagnosticsText() {
    final source = Store.tryGet(StoreKey.serverUrl);
    final endpoint = Store.tryGet(StoreKey.serverEndpoint);
    final diagnostics = EndpointSelectionDiagnosticsStore.read();
    final lines = <String>[
      'Original server: ${source ?? 'Not configured'}',
      'Current API: ${endpoint ?? 'Not resolved'}',
    ];

    if (diagnostics == null) {
      lines.add('Endpoint selection: No diagnostics yet');
      return lines.join('\n');
    }

    final candidate = diagnostics.candidateIndex == null ? '' : ', candidate ${diagnostics.candidateIndex}';
    lines.add(
      'Endpoint selection: ${diagnostics.source.name}$candidate, '
      '${diagnostics.reason.name}, ${diagnostics.status.name}',
    );
    lines.add('Endpoint checked: ${DateFormat.yMd().add_Hms().format(diagnostics.checkedAt)}');
    if (diagnostics.detail != null) {
      lines.add('Endpoint detail: ${diagnostics.detail}');
    }
    return lines.join('\n');
  }

  Future<void> _showAndCopyDiagnostics(BackgroundWorkerDiagnostics value) async {
    final report =
        'Last trigger: ${_formatTimestamp(value.lastTriggerAt)}\n'
        'Last start: ${_formatTimestamp(value.lastStartedAt)}\n'
        'Last success: ${_formatTimestamp(value.lastSucceededAt)}\n'
        'Pending: ${value.pendingCount}, retrying: ${value.retryingCount}, failed: ${value.failedCount}\n'
        '${_endpointDiagnosticsText()}\n'
        '${value.lastError ?? 'No native diagnostic details'}';
    await Clipboard.setData(ClipboardData(text: report));
    if (!mounted) {
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Background backup diagnostics copied'),
        content: SizedBox(
          width: double.maxFinite,
          child: SingleChildScrollView(child: SelectableText(report)),
        ),
        actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close'))],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<BackgroundWorkerDiagnostics>(
      future: _diagnostics,
      builder: (context, snapshot) {
        final value = snapshot.data;
        final subtitle = value == null
            ? 'Loading background backup status…'
            : 'Last trigger: ${_formatTimestamp(value.lastTriggerAt)}\n'
                  'Last start: ${_formatTimestamp(value.lastStartedAt)}\n'
                  'Last success: ${_formatTimestamp(value.lastSucceededAt)}\n'
                  'Pending: ${value.pendingCount}, retrying: ${value.retryingCount}, failed: ${value.failedCount}'
                  '\n${_endpointDiagnosticsText()}'
                  '${value.lastError == null ? '' : '\nNative diagnostics available; tap copy icon.'}';
        return SettingListTile(
          title: 'Background backup status',
          subtitle: subtitle,
          onTap: () async {
            await ref.read(backgroundWorkerFgServiceProvider).runNow();
            if (mounted) {
              setState(_refresh);
            }
          },
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: 'Copy diagnostics',
                icon: const Icon(Icons.content_copy),
                onPressed: value == null ? null : () => _showAndCopyDiagnostics(value),
              ),
              IconButton(
                tooltip: 'Retry now',
                icon: const Icon(Icons.refresh),
                onPressed: () async {
                  await ref.read(backgroundWorkerFgServiceProvider).runNow();
                  if (mounted) {
                    setState(_refresh);
                  }
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

class _AlbumSyncActionButton extends ConsumerStatefulWidget {
  const _AlbumSyncActionButton();

  @override
  ConsumerState<_AlbumSyncActionButton> createState() => _AlbumSyncActionButtonState();
}

class _AlbumSyncActionButtonState extends ConsumerState<_AlbumSyncActionButton> {
  bool isAlbumSyncInProgress = false;

  Future<void> _manualSyncAlbums() async {
    setState(() {
      isAlbumSyncInProgress = true;
    });

    try {
      await ref.read(backgroundSyncProvider).syncLinkedAlbum();
      await ref.read(backgroundSyncProvider).syncRemote();
    } catch (_) {
    } finally {
      Future.delayed(const Duration(seconds: 1), () {
        if (!mounted) {
          return;
        }
        setState(() {
          isAlbumSyncInProgress = false;
        });
      });
    }
  }

  Future<void> _manageLinkedAlbums() async {
    final currentUser = ref.read(currentUserProvider);
    if (currentUser == null) {
      return;
    }
    final localAlbums = ref.read(backupAlbumProvider);
    final selectedBackupAlbums = localAlbums
        .where((album) => album.backupSelection == BackupSelection.selected)
        .toList();

    await ref.read(syncLinkedAlbumServiceProvider).manageLinkedAlbums(selectedBackupAlbums, currentUser.id);
  }

  @override
  Widget build(BuildContext context) {
    final albumSyncEnable = ref.watch(appConfigProvider.select((c) => c.backup.syncAlbums));
    return Padding(
      padding: const EdgeInsets.only(left: 8.0),
      child: ListView(
        shrinkWrap: true,
        children: [
          Column(
            children: [
              SettingListTile(
                title: "sync_albums".t(context: context),
                subtitle: "sync_upload_album_setting_subtitle".t(context: context),
                trailing: Switch(
                  value: albumSyncEnable,
                  onChanged: (bool newValue) async {
                    await ref.read(settingsProvider).write(.backupSyncAlbums, newValue);

                    if (newValue == true) {
                      await _manageLinkedAlbums();
                    }
                  },
                ),
              ),
              AnimatedSize(
                duration: const Duration(milliseconds: 300),
                curve: Curves.easeInOut,
                child: AnimatedOpacity(
                  duration: const Duration(milliseconds: 200),
                  opacity: albumSyncEnable ? 1.0 : 0.0,
                  child: albumSyncEnable
                      ? SettingListTile(
                          onTap: _manualSyncAlbums,
                          contentPadding: const EdgeInsets.only(left: 32, right: 16),
                          title: "organize_into_albums".t(context: context),
                          subtitle: "organize_into_albums_description".t(context: context),
                          trailing: isAlbumSyncInProgress
                              ? const SizedBox(
                                  width: 32,
                                  height: 32,
                                  child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                                )
                              : IconButton(
                                  onPressed: _manualSyncAlbums,
                                  icon: const Icon(Icons.sync_rounded),
                                  color: context.colorScheme.onSurface.withValues(alpha: 0.7),
                                  iconSize: 20,
                                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                                ),
                        )
                      : const SizedBox.shrink(),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BackupSwitchTile extends ConsumerWidget {
  final SettingsKey<bool> metadataKey;
  final bool Function(AppConfig) selector;
  final String titleKey;
  final String subtitleKey;
  final FutureOr<void> Function(bool)? onChanged;

  const _BackupSwitchTile({
    required this.metadataKey,
    required this.selector,
    required this.titleKey,
    required this.subtitleKey,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(appConfigProvider.select(selector));
    return Padding(
      padding: const EdgeInsets.only(left: 8.0),
      child: SettingListTile(
        title: titleKey.t(context: context),
        subtitle: subtitleKey.t(context: context),
        trailing: Switch(
          value: value,
          onChanged: (bool newValue) async {
            await ref.read(settingsProvider).write(metadataKey, newValue);
            await onChanged?.call(newValue);
          },
        ),
      ),
    );
  }
}

class _UseCellularForVideosButton extends ConsumerWidget {
  const _UseCellularForVideosButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Future<void> applyNetworkPolicy(bool _) async {
      await ref.read(backgroundUploadServiceProvider).refreshUploadNetworkPolicy();
      await ref.read(backgroundWorkerFgServiceProvider).runNow();
    }

    return _BackupSwitchTile(
      metadataKey: SettingsKey.backupUseCellularForVideos,
      selector: (c) => c.backup.useCellularForVideos,
      titleKey: "videos",
      subtitleKey: "network_requirement_videos_upload",
      onChanged: applyNetworkPolicy,
    );
  }
}

class _UseCellularForPhotosButton extends ConsumerWidget {
  const _UseCellularForPhotosButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Future<void> applyNetworkPolicy(bool _) async {
      await ref.read(backgroundUploadServiceProvider).refreshUploadNetworkPolicy();
      await ref.read(backgroundWorkerFgServiceProvider).runNow();
    }

    return _BackupSwitchTile(
      metadataKey: SettingsKey.backupUseCellularForPhotos,
      selector: (c) => c.backup.useCellularForPhotos,
      titleKey: "photos",
      subtitleKey: "network_requirement_photos_upload",
      onChanged: applyNetworkPolicy,
    );
  }
}

class _BackupOnlyWhenChargingButton extends ConsumerWidget {
  const _BackupOnlyWhenChargingButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fgService = ref.read(backgroundWorkerFgServiceProvider);
    return _BackupSwitchTile(
      metadataKey: SettingsKey.backupRequireCharging,
      selector: (c) => c.backup.requireCharging,
      titleKey: "charging",
      subtitleKey: "charging_requirement_mobile_backup",
      onChanged: (value) {
        fgService.configure(requireCharging: value);
      },
    );
  }
}

class _BackupDelaySlider extends ConsumerWidget {
  const _BackupDelaySlider();

  static int backupDelayToSliderValue(int ms) => switch (ms) {
    5 => 0,
    30 => 1,
    120 => 2,
    _ => 3,
  };

  static int backupDelayToSeconds(int v) => switch (v) {
    0 => 5,
    1 => 30,
    2 => 120,
    _ => 600,
  };

  static String formatBackupDelaySliderValue(int v) => switch (v) {
    0 => 'setting_notifications_notify_seconds'.tr(namedArgs: {'count': '5'}),
    1 => 'setting_notifications_notify_seconds'.tr(namedArgs: {'count': '30'}),
    2 => 'setting_notifications_notify_minutes'.tr(namedArgs: {'count': '2'}),
    _ => 'setting_notifications_notify_minutes'.tr(namedArgs: {'count': '10'}),
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final triggerDelay = ref.watch(appConfigProvider.select((c) => c.backup.triggerDelay));
    final currentValue = backupDelayToSliderValue(triggerDelay);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 24.0, top: 8.0),
          child: Text(
            'backup_controller_page_background_delay'.tr(
              namedArgs: {'duration': formatBackupDelaySliderValue(currentValue)},
            ),
            style: context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w500),
          ),
        ),
        Slider(
          value: currentValue.toDouble(),
          onChanged: (double v) async {
            final seconds = backupDelayToSeconds(v.toInt());
            await ref.read(settingsProvider).write(SettingsKey.backupTriggerDelay, seconds);
          },
          onChangeEnd: (double v) async {
            final seconds = backupDelayToSeconds(v.toInt());
            await ref.read(settingsProvider).write(SettingsKey.backupTriggerDelay, seconds);
            await ref.read(backgroundWorkerFgServiceProvider).configure(minimumDelaySeconds: seconds);
          },
          max: 3.0,
          min: 0.0,
          divisions: 3,
          label: formatBackupDelaySliderValue(currentValue),
        ),
      ],
    );
  }
}
