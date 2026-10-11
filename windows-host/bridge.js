(() => {
  const webview = window.chrome?.webview;
  if (!webview) return;

  // Keep the renderer-facing surface narrow. Native handlers must validate every message.
  window.yuyinWebViewBridge = Object.freeze({
    postMessage(message) {
      webview.postMessage(message);
    },
  });
  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
    for (let node = event.target; node; node = node.parentElement) {
      if (node.matches('button, input, select, textarea, a, [role="menu"], [role="menuitem"]')) return;
      const region = getComputedStyle(node).getPropertyValue('-webkit-app-region').trim();
      if (region === 'no-drag') return;
      if (region === 'drag') { webview.postMessage({ type: 'invoke', id: 0, method: 'window.drag', args: [] }); return; }
    }
  });
})();
