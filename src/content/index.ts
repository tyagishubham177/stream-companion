import { ContentController } from './controller';

if (window.top === window) {
  const controller = new ContentController();
  controller.start();
  window.addEventListener('pagehide', () => controller.dispose(), { once: true });
}
