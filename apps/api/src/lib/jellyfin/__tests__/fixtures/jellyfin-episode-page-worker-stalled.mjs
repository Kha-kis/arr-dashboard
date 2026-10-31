// Synthetic GET actor deliberately omits cancellation to model a read whose
// own timeout never settles. The parent must close its real loopback socket.
import { workerData } from "node:worker_threads";
const response = await fetch(workerData.baseUrl);
await response.text();
