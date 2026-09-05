import { parentPort, workerData } from 'node:worker_threads';
import { captureBrowserHistory, captureBrowserVisits } from '@life-logger/capture';
import { generateBrowserHistorySummary, transcribeWavFile } from '@life-logger/ai';
async function run() {
  if (workerData.task === 'clues') return captureBrowserVisits(workerData.input);
  return workerData.task === 'voice'
    ? transcribeWavFile(workerData.input)
    : generateBrowserHistorySummary(await captureBrowserHistory(workerData.input));
}
void run().then(result => parentPort?.postMessage({ result }), error => parentPort?.postMessage({ error: error instanceof Error ? error.message : '后台处理失败' }));
