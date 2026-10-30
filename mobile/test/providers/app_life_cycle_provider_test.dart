import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/providers/app_life_cycle.provider.dart';

void main() {
  test('Android background handoff stops foreground upload before scheduling background work', () async {
    final events = <String>[];

    await handoffAndroidBackupToBackground(
      stopForegroundBackup: () => events.add('stop'),
      runBackgroundBackupNow: () async => events.add('run-now'),
    );

    expect(events, ['stop', 'run-now']);
  });

  test('Android background handoff waits for the atomic native schedule call', () async {
    final scheduleCompleter = Completer<void>();
    var stopped = false;
    var completed = false;

    final handoff = handoffAndroidBackupToBackground(
      stopForegroundBackup: () => stopped = true,
      runBackgroundBackupNow: () => scheduleCompleter.future,
    );
    unawaited(handoff.then((_) => completed = true));

    await Future<void>.delayed(Duration.zero);
    expect(stopped, isTrue);
    expect(completed, isFalse);

    scheduleCompleter.complete();
    await handoff;
    expect(completed, isTrue);
  });

  test('hidden and paused lifecycle events share one Android handoff', () async {
    final coordinator = AndroidBackgroundHandoffCoordinator();
    final handoffCompleter = Completer<void>();
    var calls = 0;

    final hidden = coordinator.run(() {
      calls++;
      return handoffCompleter.future;
    });
    final paused = coordinator.run(() async => calls++);

    expect(calls, 1);
    expect(identical(hidden, paused), isTrue);

    handoffCompleter.complete();
    await Future.wait([hidden, paused]);

    coordinator.reset();
    await coordinator.run(() async => calls++);
    expect(calls, 2);
  });

  test('foreground backup starts only after remote sync completes', () async {
    final syncCompleter = Completer<bool>();
    final events = <String>[];

    final pipeline = runForegroundResumePipeline(
      syncLocal: () async => events.add('sync-local'),
      syncRemote: () {
        events.add('sync-remote');
        return syncCompleter.future;
      },
      reconcileCompletedUploads: () async => events.add('reconcile'),
      hashAssets: () async => events.add('hash'),
      resumeBackup: () async => events.add('backup'),
      onSyncComplete: () => events.add('sync-complete'),
    );
    expect(events, ['sync-local', 'sync-remote']);

    syncCompleter.complete(false);
    await pipeline;

    expect(events, ['sync-local', 'sync-remote', 'sync-complete', 'hash']);
  });

  test('foreground backup starts after successful sync and hashing', () async {
    final events = <String>[];

    final result = await runForegroundResumePipeline(
      syncLocal: () async => events.add('sync-local'),
      syncRemote: () async {
        events.add('sync-remote');
        return true;
      },
      reconcileCompletedUploads: () async => events.add('reconcile'),
      hashAssets: () async => events.add('hash'),
      resumeBackup: () async => events.add('backup'),
      onSyncComplete: () => events.add('sync-complete'),
    );

    expect(result, isTrue);
    expect(events, ['sync-local', 'sync-remote', 'sync-complete', 'hash', 'reconcile', 'backup']);
  });
}
