/**
 * MessageAttachments — visual attachment cards rendered above a message's
 * text (desktop MessageAttachments.tsx parity).
 *
 * Attachments are not structured data on a persisted message — the desktop
 * folds them into the content as text markers at send time:
 *   [Attached image: NAME] / [Attached image: NAME|<desktop path>]
 *   Attached file: NAME\n```\nEXTRACTED\n```     (doc/text + extracted body)
 *   [Attached file NAME could not be read as text.]
 *   [Connected: NAME, NAME]                      (connector chips)
 *
 * This module parses those markers out (same regex as the desktop), renders
 * each as a card — real thumbnail for images (fetched over the relay via
 * ReadArtifactPreview, whose gate includes the desktop's chat-uploads dir),
 * a glyph + name row for docs/text — and returns the cleaned text so the
 * markers never appear as raw content.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, ActivityIndicator } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import {
  useRelay,
  onArtifactPreview,
  getCachedArtifactPreview,
  type ArtifactPreview,
} from '../../hooks/useRelay';

export interface ParsedAttachment {
  key: string;
  name: string;
  kind: 'image' | 'doc' | 'text';
  /** Desktop-side path for persisted images (thumbnail source). */
  path?: string;
  /** Short excerpt of extracted doc/text content. */
  preview?: string;
}

/** Combined marker regex — mirrors the desktop's RE_ANY (positional groups:
 *  1 image, 2 unreadable doc, 3+4 doc/text name+body, 5 pending file). */
const RE_ANY =
  /(?:\n*\[Attached image: ([^\]]+)\]\n*)|(?:\n*\[Attached file ([^\]]+) could not be read as text\.\]\n*)|(?:\n*Attached file: (.+?)\n```(?:\r?\n)([\s\S]*?)\r?\n```)|(?:\n*\[Attached file: ([^\]]+)\]\n*)|(?:\n*\[Connected: ([^\]]+)\]\n*)/g;

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

const DOC_EXTS = ['docx', 'pptx', 'xlsx', 'pdf', 'doc', 'ppt', 'xls'];

/** Split "NAME|<path>" image markers (the saved desktop path rides after a
 *  pipe; older history has no path). */
function splitImageMarker(marker: string): { name: string; path?: string } {
  const pipe = marker.lastIndexOf('|');
  if (pipe > 0) {
    return { name: marker.slice(0, pipe).trim(), path: marker.slice(pipe + 1).trim() };
  }
  return { name: marker.trim() };
}

/** Parse attachment markers out of `content`. Returns the cards to render and
 *  the content with every marker stripped. */
export function parseAttachments(content: string): { attachments: ParsedAttachment[]; text: string } {
  const attachments: ParsedAttachment[] = [];
  let i = 0;
  for (const m of content.matchAll(RE_ANY)) {
    if (m[1] != null) {
      const { name, path } = splitImageMarker(m[1]);
      attachments.push({ key: `img-${i++}`, name, kind: 'image', path });
    } else if (m[2] != null) {
      attachments.push({
        key: `unread-${i++}`,
        name: m[2].trim(),
        kind: 'doc',
        preview: 'Could not be read as text',
      });
    } else if (m[3] != null) {
      const name = m[3].trim();
      const ext = extOf(name);
      attachments.push({
        key: `doc-${i++}`,
        name,
        kind: ext && DOC_EXTS.includes(ext) ? 'doc' : 'text',
        preview: (m[4] ?? '').trim().slice(0, 280),
      });
    } else if (m[5] != null) {
      const name = m[5].trim();
      const ext = extOf(name);
      attachments.push({
        key: `pending-${i++}`,
        name,
        kind: ext && DOC_EXTS.includes(ext) ? 'doc' : 'text',
      });
    }
    // m[6] ([Connected: …]) is stripped but not rendered on the phone.
  }
  const text = content.replace(RE_ANY, '').trim();
  return { attachments, text };
}

/** One image card: the real thumbnail once the relay preview lands (the
 *  content marker carries the desktop path), a quiet placeholder before. */
function ImageCard({ name, path }: { name: string; path?: string }) {
  const c = theme.colors;
  const { readArtifactPreview } = useRelay();
  const [preview, setPreview] = useState<ArtifactPreview | null>(() =>
    path ? getCachedArtifactPreview(path) ?? null : null,
  );

  useEffect(() => {
    if (!path) return;
    if (getCachedArtifactPreview(path)) return;
    readArtifactPreview(path);
    const off = onArtifactPreview.on((p) => {
      if (p.preview.path === path) setPreview(p.preview);
    });
    return off;
  }, [path, readArtifactPreview]);

  if (preview?.data_uri) {
    return (
      <View style={[styles.imageCard, { backgroundColor: c.surface2 }]}>
        <Image source={{ uri: preview.data_uri }} style={styles.image} resizeMode="cover" />
      </View>
    );
  }
  return (
    <View style={[styles.fileCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <View style={[styles.fileIconWrap, { backgroundColor: c.bubble }]}>
        {path ? <ActivityIndicator size="small" color={c.textSecondary} /> : (
          <Ionicons name="image-outline" size={16} color={c.textSecondary} />
        )}
      </View>
      <View style={styles.fileText}>
        <Text style={[styles.fileName, { color: c.text }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.fileMeta, { color: c.textSecondary }]}>Image</Text>
      </View>
    </View>
  );
}

function FileCard({ name, kind, preview }: { name: string; kind: 'doc' | 'text'; preview?: string }) {
  const c = theme.colors;
  return (
    <View style={[styles.fileCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <View style={[styles.fileIconWrap, { backgroundColor: c.bubble }]}>
        <Ionicons
          name={kind === 'doc' ? 'document-text-outline' : 'document-outline'}
          size={16}
          color={c.textSecondary}
        />
      </View>
      <View style={styles.fileText}>
        <Text style={[styles.fileName, { color: c.text }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.fileMeta, { color: c.textSecondary }]} numberOfLines={1}>
          {preview ?? (kind === 'doc' ? 'Document' : 'Text file')}
        </Text>
      </View>
    </View>
  );
}

export function MessageAttachmentCards({ attachments }: { attachments: ParsedAttachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a): a is ParsedAttachment & { kind: 'image' } => a.kind === 'image');
  const files = attachments.filter((a): a is ParsedAttachment & { kind: 'doc' | 'text' } => a.kind !== 'image');
  return (
    <View style={styles.wrap}>
      {images.length > 0 ? (
        <View style={styles.imageRow}>
          {images.map((a) => <ImageCard key={a.key} name={a.name} path={a.path} />)}
        </View>
      ) : null}
      {files.map((a) => <FileCard key={a.key} name={a.name} kind={a.kind} preview={a.preview} />)}
    </View>
  );
}


/** Images we ALREADY hold locally (optimistic just-sent message) — rendered
 *  straight from their data URIs, no relay round-trip. */
export function LocalImageCards({ images }: { images: { name: string; dataUri: string }[] }) {
  if (images.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.imageRow}>
        {images.map((img) => (
          <View key={img.name + img.dataUri.length} style={[styles.imageCard, { backgroundColor: theme.colors.surface2 }]}>
            <Image source={{ uri: img.dataUri }} style={styles.image} resizeMode="cover" />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, marginBottom: 6 },
  imageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  imageCard: {
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  image: { width: 200, height: 150 },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  fileIconWrap: {
    width: 30, height: 30, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  fileText: { flexShrink: 1 },
  fileName: { fontSize: 13, fontWeight: '600' },
  fileMeta: { fontSize: 11, marginTop: 1 },
});
