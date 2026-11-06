export function metricName(task) { return task.prediction.metric ?? 'accuracy' }
export function utility(metric, score) {
  if (!Number.isFinite(score) || score < 0 || metric !== 'mean-column-wise-rmsle' && score > 1) throw new Error('invalid metric score')
  return metric === 'mean-column-wise-rmsle' ? 1 / (1 + score) : score
}
export function internalQuality(experiment) { return experiment.execution.pooledUtility ?? experiment.execution.pooledAccuracy ?? null }
export function internalScore(experiment) { return experiment.execution.pooledScore ?? experiment.execution.pooledAccuracy ?? null }
export function deliveryQuality(delivery) { return delivery.quality ?? delivery.accuracy }
