class BackupBatchPlanner {
  BackupBatchPlanner({
    Iterable<String> initialQueuedIds = const [],
    this.batchSize = 100,
    this.queueHighWatermark = 300,
  }) : queuedIds = initialQueuedIds.toSet();

  final int batchSize;
  final int queueHighWatermark;
  final Set<String> queuedIds;

  bool hasMoreCandidates = true;
  int batchCount = 0;

  int get remainingCapacity => queueHighWatermark - queuedIds.length;

  int get nextBatchLimit {
    if (!hasMoreCandidates || remainingCapacity <= 0) {
      return 0;
    }
    return remainingCapacity < batchSize ? remainingCapacity : batchSize;
  }

  void recordPage(Iterable<String> candidateIds, {required int requestedLimit}) {
    final ids = candidateIds.toList(growable: false);
    queuedIds.addAll(ids);
    batchCount++;
    if (ids.length < requestedLimit) {
      hasMoreCandidates = false;
    }
  }
}
