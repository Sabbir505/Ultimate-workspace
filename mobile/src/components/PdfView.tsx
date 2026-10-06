/**
 * PdfView — full PDF viewer for vault files (desktop PDF pane parity).
 *
 * Rendering is LAZY: page 1 paints as soon as pdf.js parses the document;
 * further pages render in small background batches. A 24 MB paper
 * (≈30 MB base64) spends ~10s on desktop read+send and 30-60s on the
 * DERP-relayed tailnet leg — rendering everything upfront used to add
 * another 15-20s of blank screen on top. Progress reporting covers both
 * stages (render page N of M) so the wait is legible.
 *
 * pdf.js itself loads from CDN once (needs internet); the document payload
 * rides the E2E relay and never leaves the phone.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { theme } from '../theme';

const PDFJS_VERSION = '3.11.174';

export default function PdfView({ base64 }: { base64: string }) {
  const c = theme.colors;
  const [ready, setReady] = useState(false); // doc parsed, page 1 rendered
  const [rendered, setRendered] = useState(1); // pages painted so far
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

  const html = useMemo(() => {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js"></script>
<style>
  html,body{margin:0;padding:0;background:#171614;}
  #pages{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px;}
  canvas{width:100%;height:auto;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.5);}
  #err{color:#D64545;font:12px monospace;padding:12px;white-space:pre-wrap;display:none;}
</style></head>
<body>
<div id="pages"></div>
<div id="err"></div>
<script>
  const POST = (m) => window.ReactNativeWebView.postMessage(m);
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js';
  // Device pixel ratio: a CSS-pixel canvas stretched by a 3x screen reads
  // as blurry — render at DPR, size back down via CSS.
  const dpr = window.devicePixelRatio || 2;
  const data = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);

  const renderPage = (pdf, n) => pdf.getPage(n).then((page) => {
    const cssScale = (window.innerWidth - 16) / page.getViewport({ scale: 1 }).width;
    const scale = Math.max(0.6, cssScale) * dpr;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = (vp.width / dpr) + 'px';
    canvas.style.height = (vp.height / dpr) + 'px';
    document.getElementById('pages').appendChild(canvas);
    return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  });

  // Render [from..to] sequentially, reporting progress after each page.
  const renderBatch = (pdf, from, to) => {
    let chain = Promise.resolve();
    for (let n = from; n <= to; n++) {
      chain = chain.then(() => renderPage(pdf, n)).then(() => {
        POST(JSON.stringify({ rendered: n }));
      });
    }
    return chain;
  };

  pdfjsLib.getDocument({ data: bytes }).promise.then((pdf) => {
    POST(JSON.stringify({ total: pdf.numPages }));
    // Page 1 NOW (first paint), then the rest in background batches.
    renderPage(pdf, 1).then(() => {
      POST(JSON.stringify({ rendered: 1 }));
      let n = 2;
      const nextBatch = () => {
        if (n > pdf.numPages) { POST(JSON.stringify({ allDone: true })); return; }
        const from = n, to = Math.min(n + 2, pdf.numPages);
        n = to + 1;
        renderBatch(pdf, from, to).then(nextBatch);
      };
      setTimeout(nextBatch, 30);
    });
  }).catch((e) => {
    const el = document.getElementById('err');
    el.style.display = 'block';
    el.textContent = 'PDF failed: ' + (e && e.message ? e.message : e);
    POST(JSON.stringify({ failed: true }));
  });
</script>
</body></html>`;
  }, [base64]);

  const onMessage = useMemo(() => (e: { nativeEvent: { data: string } }) => {
    try {
      const d = JSON.parse(e.nativeEvent.data);
      if (d.total) setTotal(d.total);
      if (d.rendered) {
        setRendered(d.rendered);
        setReady(true);
      }
      if (d.allDone) setReady(true);
      if (d.failed) setFailed('PDF failed to render.');
    } catch {
      // ignore malformed messages
    }
  }, []);

  const rendering = total > 0 && rendered < total;

  return (
    <View style={[styles.wrap, { backgroundColor: '#171614' }]}>
      <WebView
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        onMessage={onMessage}
        style={styles.web}
      />
      {!ready && !failed ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="small" color={c.accent} />
          <Text style={{ color: c.textSecondary, fontSize: 11 }}>
            {total > 0 ? `Rendering page ${rendered} of ${total}…` : 'Parsing document…'}
          </Text>
        </View>
      ) : null}
      {failed ? (
        <View style={styles.loading} pointerEvents="none">
          <Text style={{ color: c.error, fontSize: 12 }}>{failed}</Text>
        </View>
      ) : null}
      {ready && rendering ? (
        <View style={styles.counter} pointerEvents="none">
          <Text style={{ color: c.textSecondary, fontSize: 10 }}>
            rendering {rendered}/{total}…
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, borderRadius: theme.radius.md, overflow: 'hidden' },
  web: { flex: 1 },
  loading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  counter: { position: 'absolute', right: 10, bottom: 8 },
});
