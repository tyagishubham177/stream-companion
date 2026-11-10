import { ContentController } from './controller';
import { MarksController } from '../features/marks/controller';
import { onHotstarPosterMemoryChange } from '../platforms/hotstar/poster-memory';
import { HOTSTAR_ORIGIN } from '../platforms/hotstar/routes';

if (window.top === window) {
  const controller = new ContentController();
  const marks = new MarksController();
  const unsubscribe = location.origin === HOTSTAR_ORIGIN ? onHotstarPosterMemoryChange(() => {
    controller.scheduleScan(); marks.schedule();
  }) : undefined;
  controller.start();
  marks.start();
  window.addEventListener('pagehide', () => { unsubscribe?.(); controller.dispose(); marks.dispose(); }, { once: true });
}
