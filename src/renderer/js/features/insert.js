// Picking images to place on pages.
import { prepareImageFile } from '../doc/image-tools.js';
import { toast, alertDialog } from '../ui/dialogs.js';
import { t, errorMessage } from '../i18n.js';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];

export async function pickImage(doc, { tool = 'image' } = {}) {
  if (!doc) return;
  if (doc.isReadOnly()) return doc.warnReadOnly();
  const paths = await window.api.dialog.open({ filters: [{ name: t('filter.images'), extensions: IMAGE_EXTENSIONS }] });
  if (!paths.length) return;
  try {
    const bytes = await window.api.file.read(paths[0]);
    const img = await prepareImageFile(bytes, paths[0]);
    const asset = doc.session.addAsset(img.bytes, img.mime, { width: img.width, height: img.height });
    placeAsset(doc, asset, img.width, img.height, tool);
  } catch (e) {
    alertDialog(t('error.imageFailed', { message: errorMessage(e) }));
  }
}

export function placeAsset(doc, asset, width, height, tool = 'image', defaultWidth = null) {
  if (doc.mode !== 'view') doc.setMode('view');
  doc.setTool(tool);
  doc.tools.pending = { asset, width, height, defaultWidth: defaultWidth || Math.min(width * 0.75, 260) };
  toast(t('image.clickToPlace'));
}
