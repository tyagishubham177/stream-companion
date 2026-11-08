import { ContentController } from './controller';
import { MarksController } from '../features/marks/controller';

if (window.top === window) {
  const controller = new ContentController();
  controller.start();
  const marks = new MarksController();
  marks.start();
  window.addEventListener('pagehide', () => { controller.dispose(); marks.dispose(); }, { once: true });
}
