import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/services/backup_batch_queue.dart';

void main() {
  for (final count in [0, 99, 100, 101, 250]) {
    test('pages $count candidates in batches of at most 100', () {
      final planner = BackupBatchPlanner();
      final remaining = List.generate(count, (index) => 'asset-$index');
      final pageSizes = <int>[];

      while (planner.nextBatchLimit > 0) {
        final requested = planner.nextBatchLimit;
        final page = remaining.where((id) => !planner.queuedIds.contains(id)).take(requested).toList(growable: false);
        planner.recordPage(page, requestedLimit: requested);
        if (page.isNotEmpty) {
          pageSizes.add(page.length);
        }
      }

      expect(planner.queuedIds, hasLength(count));
      expect(pageSizes.every((size) => size <= 100), isTrue);
      if (count == 250) {
        expect(pageSizes, [100, 100, 50]);
      }
    });
  }

  test('excludes persisted work before applying the next 100 item limit', () {
    final existing = List.generate(100, (index) => 'asset-$index');
    final planner = BackupBatchPlanner(initialQueuedIds: existing);
    final all = List.generate(250, (index) => 'asset-$index');

    final page = all.where((id) => !planner.queuedIds.contains(id)).take(planner.nextBatchLimit).toList();

    expect(page, hasLength(100));
    expect(page.first, 'asset-100');
  });

  test('stops at the queue high watermark', () {
    final planner = BackupBatchPlanner(queueHighWatermark: 300);
    final candidates = List.generate(400, (index) => 'asset-$index');

    while (planner.nextBatchLimit > 0) {
      final requested = planner.nextBatchLimit;
      final page = candidates.where((id) => !planner.queuedIds.contains(id)).take(requested).toList();
      planner.recordPage(page, requestedLimit: requested);
    }

    expect(planner.queuedIds, hasLength(300));
    expect(planner.hasMoreCandidates, isTrue);
  });
}
