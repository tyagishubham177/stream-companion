import { overlayStyles } from './styles';

/** An invalidated content script cannot reconnect to its replacement worker. */
export function showReconnectNotice(): void {
  const host = document.createElement('div'); host.dataset.scRoot = 'reconnect';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = overlayStyles + '.notice{position:fixed;right:16px;bottom:16px;max-width:calc(100vw - 32px);padding:16px;border:1px solid #5a5a54;border-radius:10px;background:#171918;color:#f8f8f3;font-size:13px;pointer-events:auto;box-shadow:0 6px 25px #0008}.notice p{margin:0 0 12px}.notice button{padding:7px 10px;border:1px solid #edcf83;border-radius:6px;background:#edcf83;color:#191b17}.notice .dismiss{margin-left:8px;background:transparent;color:#f8f8f3;border-color:#54584e}';
  const notice = document.createElement('div'); notice.className = 'notice'; notice.setAttribute('role', 'status');
  const message = document.createElement('p'); message.textContent = 'Stream Companion disconnected. Refresh Netflix to reconnect ratings.';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh Netflix';
  refresh.addEventListener('click', () => location.reload());
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.className = 'dismiss';
  dismiss.addEventListener('click', () => host.remove());
  notice.append(message, refresh, dismiss); root.append(style, notice);
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup'])
    root.addEventListener(type, event => event.stopPropagation());
  document.documentElement.append(host);
}
