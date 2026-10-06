/**
 * MermaidView — renders a ```mermaid fenced block from a wiki page or chat.
 * Desktop renders diagrams with the mermaid library; the phone has no such
 * runtime, so the diagram source is rendered inside a WebView loading
 * mermaid from CDN (needs internet — the wiki itself lives on the desktop).
 * Height is measured from the rendered SVG via postMessage.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { theme } from '../theme';

export default function MermaidView({ code }: { code: string }) {
  const c = theme.colors;
  const [height, setHeight] = useState(220);
  const [failed, setFailed] = useState(false);

  const html = useMemo(() => {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
  html,body{margin:0;padding:8px;background:transparent;}
  #graph{display:flex;justify-content:center;}
  .mermaid{width:100%;}
  .error{color:#D64545;font:12px monospace;white-space:pre-wrap;}
</style></head>
<body>
<div id="graph"><pre class="mermaid" id="src">${escaped}</pre></div>
<script>
  const DARK = ${JSON.stringify(c.background === '#FFFFFF' ? false : true)};
  mermaid.initialize({ startOnLoad: false, theme: DARK ? 'dark' : 'default' });
  mermaid.run({ querySelector: '#src' }).then(() => {
    const h = document.getElementById('graph').scrollHeight;
    setTimeout(() => window.ReactNativeWebView.postMessage(JSON.stringify({ h: Math.min(900, Math.max(120, h + 20)) })), 60);
  }).catch((e) => {
    document.getElementById('graph').innerHTML = '<div class="error">' + (e && e.message ? e.message : 'diagram failed') + '</div>';
    setTimeout(() => window.ReactNativeWebView.postMessage(JSON.stringify({ h: 60, error: true })), 30);
  });
  window.addEventListener('resize', () => {
    const h = document.getElementById('graph').scrollHeight;
    window.ReactNativeWebView.postMessage(JSON.stringify({ h: Math.min(900, Math.max(120, h + 20)) }));
  });
</script>
</body></html>`;
  }, [code, c.background]);

  if (failed) {
    return (
      <View style={[styles.wrap, { backgroundColor: c.surface2 }]}>
        <Text style={[styles.fallback, { color: c.textSecondary }]}>Diagram (mermaid) — render on desktop.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { backgroundColor: c.surface2, height }]}>
      <WebView
        source={{ html }}
        originWhitelist={['*']}
        scrollEnabled={false}
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={(e) => {
          try {
            const data = JSON.parse(e.nativeEvent.data);
            if (typeof data.h === 'number') setHeight(data.h);
            if (data.error) setFailed(true);
          } catch {
            // ignore malformed messages
          }
        }}
        renderLoading={() => (
          <ActivityIndicator size="small" color={c.textSecondary} style={styles.loading} />
        )}
        startInLoadingState
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.sm,
    overflow: 'hidden',
  },
  loading: { position: 'absolute', alignSelf: 'center', top: 12 },
  fallback: { fontSize: 12, padding: 12 },
});
