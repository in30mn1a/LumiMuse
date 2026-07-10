const { JSDOM } = require('jsdom');

const GLOBAL_KEYS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'MutationObserver',
  'DOMRect',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

function installDomTestEnvironment() {
  const previous = new Map(GLOBAL_KEYS.map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;

  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent || window.MouseEvent,
    MutationObserver: window.MutationObserver,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: handle => clearTimeout(handle),
  };

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(global, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return () => {
    window.document.body.replaceChildren();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(global, key, descriptor);
      } else {
        delete global[key];
      }
    }
  };
}

module.exports = { installDomTestEnvironment };
