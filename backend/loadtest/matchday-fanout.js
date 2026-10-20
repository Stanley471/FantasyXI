// k6 run -e TOKEN=<local-test-jwt> -e WS_URL=ws://localhost:5000/api/v1/live/1/ws loadtest/matchday-fanout.js
// Run npm run test:fanout:load concurrently to generate the paced Redis event burst.
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
const deltas = new Counter('matchday_delta_frames');
export const options = {
  vus: Number(__ENV.CLIENTS || 100),
  duration: '30s',
  thresholds: { checks: ['rate>0.99'], matchday_delta_frames: ['count>0'] },
};
export default function () {
  const response = ws.connect(__ENV.WS_URL || 'ws://localhost:5000/api/v1/live/1/ws', {}, socket => {
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: __ENV.TOKEN })));
    socket.on('message', raw => { if (JSON.parse(raw).type === 'delta') deltas.add(1); });
    socket.setTimeout(() => socket.close(), 25000);
  });
  check(response, { 'WebSocket upgrade accepted': result => result && result.status === 101 });
}
