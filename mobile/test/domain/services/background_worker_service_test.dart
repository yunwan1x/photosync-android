import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/services/background_worker.service.dart';

void main() {
  test('Android backup is enqueued after sync and completed-upload reconciliation', () async {
    final syncCompleter = Completer<bool>();
    final events = <String>[];

    final pipeline = runAndroidBackgroundPipeline(
      enqueueBackup: () async => events.add('backup'),
      syncAssets: () {
        events.add('sync');
        return syncCompleter.future;
      },
      reconcileCompletedUploads: () async => events.add('reconcile'),
    );

    await Future<void>.delayed(Duration.zero);
    expect(events, ['sync']);

    syncCompleter.complete(true);
    await pipeline;
    expect(events, ['sync', 'reconcile', 'backup']);
  });

  test('Android backup does not perform a second pass after failed sync', () async {
    var backupPasses = 0;

    final result = await runAndroidBackgroundPipeline(
      enqueueBackup: () async => backupPasses++,
      syncAssets: () async => false,
      reconcileCompletedUploads: () async => fail('must not reconcile after failed sync'),
    );

    expect(result, isFalse);
    expect(backupPasses, 0);
  });

  test('Android worker deadline interrupts a stalled pipeline and runs timeout cleanup', () async {
    final stalled = Completer<void>();
    var timeoutHandled = false;

    await expectLater(
      runWithAndroidBackgroundDeadline<void>(
        operation: () => stalled.future,
        timeout: const Duration(milliseconds: 20),
        onTimeout: () async => timeoutHandled = true,
      ),
      throwsA(isA<TimeoutException>()),
    );

    expect(timeoutHandled, isTrue);
  });

  test('Android worker deadline does not run timeout cleanup after normal completion', () async {
    var timeoutHandled = false;

    final result = await runWithAndroidBackgroundDeadline<int>(
      operation: () async => 42,
      timeout: const Duration(seconds: 1),
      onTimeout: () async => timeoutHandled = true,
    );

    expect(result, 42);
    expect(timeoutHandled, isFalse);
  });
}
