// shared/ml_indicators.js

export function getMLBadge(mlMeta, hr) {
  if (hr === 'REMOVED') {
    return { label: '○ No Sensor', style: 'removed' };
  }
  
  if (mlMeta.sourcePath === 'ANOMALY_REPLACED' || mlMeta.anomalyDetected === true) {
    return { label: '⚠ Anomaly', style: 'anomaly' };
  }
  
  if (mlMeta.cleaned === false) {
    return { label: '· Raw', style: 'raw' };
  }

  if (mlMeta.sourcePath === 'STAT') {
    return { label: '~ Smoothed', style: 'smoothed' };
  }
  
  if (mlMeta.sourcePath === 'ML') {
    return { label: '✦ ML Clean', style: 'clean' };
  }
  
  return { label: '· Unknown', style: 'unknown' };
}
