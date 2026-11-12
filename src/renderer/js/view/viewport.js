// Minimal viewport with the same math as pdf.js PageViewport (used for blank
// pages and generic geometry conversions).
export class SimpleViewport {
  constructor({ viewBox, scale, rotation }) {
    this.viewBox = viewBox;
    this.scale = scale;
    this.rotation = ((rotation % 360) + 360) % 360;
    this.userUnit = 1;
    const centerX = (viewBox[2] + viewBox[0]) / 2;
    const centerY = (viewBox[3] + viewBox[1]) / 2;
    let a;
    let b;
    let c;
    let d;
    switch (this.rotation) {
      case 180:
        [a, b, c, d] = [-1, 0, 0, 1];
        break;
      case 90:
        [a, b, c, d] = [0, 1, 1, 0];
        break;
      case 270:
        [a, b, c, d] = [0, -1, -1, 0];
        break;
      default:
        [a, b, c, d] = [1, 0, 0, -1];
    }
    let offsetCanvasX;
    let offsetCanvasY;
    if (a === 0) {
      offsetCanvasX = Math.abs(centerY - viewBox[1]) * scale;
      offsetCanvasY = Math.abs(centerX - viewBox[0]) * scale;
      this.width = (viewBox[3] - viewBox[1]) * scale;
      this.height = (viewBox[2] - viewBox[0]) * scale;
    } else {
      offsetCanvasX = Math.abs(centerX - viewBox[0]) * scale;
      offsetCanvasY = Math.abs(centerY - viewBox[1]) * scale;
      this.width = (viewBox[2] - viewBox[0]) * scale;
      this.height = (viewBox[3] - viewBox[1]) * scale;
    }
    this.transform = [a * scale, b * scale, c * scale, d * scale, offsetCanvasX - a * scale * centerX - c * scale * centerY, offsetCanvasY - b * scale * centerX - d * scale * centerY];
  }
  get rawDims() {
    const v = this.viewBox;
    return { pageWidth: v[2] - v[0], pageHeight: v[3] - v[1], pageX: v[0], pageY: v[1] };
  }
  convertToViewportPoint(x, y) {
    const m = this.transform;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  convertToViewportRectangle(rect) {
    const p1 = this.convertToViewportPoint(rect[0], rect[1]);
    const p2 = this.convertToViewportPoint(rect[2], rect[3]);
    return [p1[0], p1[1], p2[0], p2[1]];
  }
  convertToPdfPoint(x, y) {
    const m = this.transform;
    const det = m[0] * m[3] - m[1] * m[2];
    const xt = x - m[4];
    const yt = y - m[5];
    return [(xt * m[3] - yt * m[2]) / det, (yt * m[0] - xt * m[1]) / det];
  }
  clone({ scale = this.scale, rotation = this.rotation } = {}) {
    return new SimpleViewport({ viewBox: this.viewBox.slice(), scale, rotation });
  }
}

// View-space rectangle {left, top, width, height} for a user-space rect.
export function viewRect(viewport, rect) {
  const a = viewport.convertToViewportPoint(rect[0], rect[1]);
  const b = viewport.convertToViewportPoint(rect[2], rect[3]);
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  return { left, top, width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
}

// User-space rect for a view-space box.
export function userRect(viewport, left, top, width, height) {
  const a = viewport.convertToPdfPoint(left, top);
  const b = viewport.convertToPdfPoint(left + width, top + height);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}
