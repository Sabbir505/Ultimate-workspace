/**
 * WikiScreen — phone mirror of the desktop's project wiki panel. Lists every
 * project wiki (pages, freshness, last build), lets you read pages as
 * markdown, and drives update/rebuild — the jobs themselves run desktop-side;
 * the screen polls the status snapshot while one is in flight.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollView, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Alert, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  useRelay, onWikiList, onWikiDetail, onWikiPage,
  type WikiProjectSummary, type WikiStatusData, type WikiPageFull,
} from '../hooks/useRelay';
import { useRelayList } from '../hooks/useRelayList';
import { tapLight } from '../lib/haptics';
import { screenCacheGet, screenCacheSet, screenCacheHas } from '../lib/screenCache';
import { timeAgo } from '../lib/format';
import { ScreenLoading, FadeIn } from '../components/ScreenFeedback';
import DomainErrorBar from '../components/DomainErrorBar';
import ScreenHeader from '../components/ScreenHeader';
import MarkdownText from '../components/chat/MarkdownText';

const STATUS_COLOR: Record<string, string> = {
  fresh: theme.colors.success,
  stale: '#e0b341',
  rebuilding: theme.colors.accent,
  failed: theme.colors.error,
};

export default function WikiScreen() {
  useScreenMountTiming('WikiScreen');
  const c = theme.colors;
  const {
    connected, getWikiList, getWiki, readWikiPage, updateWiki, rebuildWiki, cancelWikiJob,
  } = useRelay();
  const [summaries, setSummaries] = useState<WikiProjectSummary[]>(() =>
    screenCacheGet<WikiProjectSummary[]>('wiki.summaries') ?? [],
  );
  const [loaded, setLoaded] = useState(() => screenCacheHas('wiki.summaries'));
  // null = project list view; set = the detail view for that project.
  const [activePath, setActivePath] = useState<string | null>(null);
  const [status, setStatus] = useState<WikiStatusData | null>(null);
  const [page, setPage] = useState<WikiPageFull | null>(null);
  const [loadingPage, setLoadingPage] = useState<string | null>(null);

  const refreshList = useCallback(() => { getWikiList(); }, [getWikiList]);
  useRelayList(refreshList);

  // In-app back: the screen has a view stack (list → detail → page); the
  // hardware/gesture back walks it DOWN before leaving the screen — popping
  // straight to Settings skipped the wiki the user was reading.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page) { setPage(null); return true; }
      if (activePath) { setActivePath(null); setStatus(null); return true; }
      return false;
    });
    return () => sub.remove();
  }, [page, activePath]);

  // Detail view: seed the cached status snapshot for instant paint, fetch
  // fresh (only while connected), and poll while a job runs.
  const [detailCacheKey, setDetailCacheKey] = useState<string | null>(null);
  useEffect(() => {
    if (!activePath) {
      setDetailCacheKey(null);
      setStatus(null);
      return;
    }
    setStatus(screenCacheGet<WikiStatusData>(`wiki.detail:${activePath}`) ?? null);
    setDetailCacheKey(activePath);
  }, [activePath]);
  useEffect(() => {
    if (!activePath || !detailCacheKey) return;
    if (!connected) return; // offline: the cached snapshot stays on screen
    getWiki(activePath);
    if (!status?.jobRunning) return;
    const t = setInterval(() => getWiki(activePath), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, detailCacheKey, connected, status?.jobRunning]);
  useEffect(() => {
    if (activePath && status) screenCacheSet(`wiki.detail:${activePath}`, status);
  }, [activePath, status]);

  useEffect(() => {
    const offList = onWikiList.on(({ projects }) => {
      screenCacheSet('wiki.summaries', projects);
      setSummaries(projects);
      setLoaded(true);
    });
    const offDetail = onWikiDetail.on(({ status: st }) => setStatus(st));
    const offPage = onWikiPage.on(({ page: p }) => {
      setPage(p);
      setLoadingPage(null);
    });
    return () => { offList(); offDetail(); offPage(); };
  }, []);

  const openProject = useCallback((path: string) => {
    tapLight();
    setStatus(null);
    setPage(null);
    setActivePath(path);
    getWiki(path);
  }, [getWiki]);

  const openPage = useCallback((path: string, slug: string) => {
    tapLight();
    setLoadingPage(slug);
    setPage(null);
    readWikiPage(path, slug);
  }, [readWikiPage]);

  const projectName = useMemo(
    () => (activePath ? activePath.split(/[\\/]/).filter(Boolean).pop() ?? activePath : null),
    [activePath],
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      {activePath ? (
        <View style={[styles.header, { backgroundColor: c.background, borderBottomColor: c.border }]}>
          <TouchableOpacity
            onPress={() => { tapLight(); if (page) { setPage(null); } else { setActivePath(null); setStatus(null); } }}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="arrow-back" size={20} color={c.text} />
          </TouchableOpacity>
          <Text numberOfLines={1} style={[styles.headerTitle, { color: c.text }]}>
            {page ? page.title : projectName ? `${projectName} wiki` : 'Wiki'}
          </Text>
        </View>
      ) : (
        <ScreenHeader title="Wiki" errorDomains={['wiki']} />
      )}
      <DomainErrorBar domains={['wiki']} />

      {page ? (
        // Page reader
        <FadeIn style={styles.flex}>
          <ScrollView style={styles.list} contentContainerStyle={styles.pageBody}>
            <Text style={[styles.pageTitle, { color: c.text }]}>{page.title}</Text>
            {page.brief ? (
              <Text style={[styles.pageBrief, { color: c.textSecondary }]}>{page.brief}</Text>
            ) : null}
            <View style={styles.pageMetaRow}>
              <Text
                style={[styles.statusChip, { color: STATUS_COLOR[page.status] ?? c.textSecondary }]}
              >
                {page.status}
              </Text>
              <Text style={{ color: c.textSecondary, fontSize: 10 }}>
                {timeAgo(page.generatedAt)} · by {page.generatedBy ?? 'model'}
              </Text>
            </View>
            <MarkdownText content={page.body} />
            {page.files.length > 0 ? (
              <View style={[styles.filesCard, { backgroundColor: c.surface2, borderColor: c.border }]}>
                <Text style={[styles.filesTitle, { color: c.textSecondary }]}>Source files</Text>
                {page.files.map((f) => (
                  <Text key={f} numberOfLines={1} style={[styles.fileRow, { color: c.textSecondary }]}>
                    {f}
                  </Text>
                ))}
              </View>
            ) : null}
          </ScrollView>
        </FadeIn>
      ) : activePath ? (
        // Project detail: status + pages + job actions
        !status ? (
          <ScreenLoading label="Loading wiki" />
        ) : (
          <FadeIn style={styles.flex}>
            <ScrollView style={styles.list} contentContainerStyle={styles.body}>
              {status.jobRunning ? (
                <View style={[styles.jobBanner, { backgroundColor: c.surface2, borderColor: c.border }]}>
                  <ActivityIndicator size="small" color={c.accent} />
                  <Text style={{ color: c.text, fontSize: 12, flex: 1 }}>
                    Wiki job running — pages refresh as they land.
                  </Text>
                  <TouchableOpacity
                    onPress={() => cancelWikiJob(activePath)}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel wiki job"
                  >
                    <Ionicons name="close-circle" size={20} color={c.error} />
                  </TouchableOpacity>
                </View>
              ) : null}
              <View style={styles.actionsRow}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: c.accent, opacity: status.jobRunning ? 0.4 : 1 }]}
                  disabled={status.jobRunning}
                  onPress={() => { tapLight(); updateWiki(activePath); }}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Update wiki now"
                >
                  <Ionicons name="refresh" size={14} color={c.white} />
                  <Text style={{ color: c.white, fontSize: 12, fontWeight: '700' }}>Update now</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: c.border, opacity: status.jobRunning ? 0.4 : 1 }]}
                  disabled={status.jobRunning}
                  onPress={() =>
                    Alert.alert(
                      'Rebuild wiki',
                      'A full rebuild re-generates every page with the build model. This can take a while and costs tokens. Rebuild?',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Rebuild', onPress: () => rebuildWiki(activePath) },
                      ],
                    )
                  }
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Rebuild wiki"
                >
                  <Ionicons name="construct-outline" size={14} color={c.text} />
                  <Text style={{ color: c.text, fontSize: 12, fontWeight: '700' }}>Rebuild</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.flagsRow}>
                <Text style={{ color: c.textSecondary, fontSize: 11 }}>
                  auto-update {status.autoUpdate ? 'on' : 'off'} · wiki layer {status.layerIndex ? 'on' : 'off'}
                  {!status.hasModel ? ' · no build model configured' : ''}
                </Text>
              </View>
              {status.pages.length === 0 ? (
                <Text style={[styles.empty, { color: c.textSecondary }]}>
                  No pages yet. Run Update now to build the wiki from this project.
                </Text>
              ) : (
                status.pages.map((pg) => (
                  <TouchableOpacity
                    key={pg.slug}
                    style={[styles.pageCard, { backgroundColor: c.surface2, borderColor: c.border }]}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Read ${pg.title}`}
                    onPress={() => openPage(activePath, pg.slug)}
                  >
                    <View style={styles.pageCardHead}>
                      <Text numberOfLines={1} style={[styles.pageCardTitle, { color: c.text }]}>
                        {pg.title}
                      </Text>
                      <Text style={[styles.statusChip, { color: STATUS_COLOR[pg.status] ?? c.textSecondary }]}>
                        {pg.status}
                      </Text>
                    </View>
                    {pg.summary ? (
                      <Text numberOfLines={2} style={{ color: c.textSecondary, fontSize: 12 }}>
                        {pg.summary}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </FadeIn>
        )
      ) : (
        // Project list
        !loaded ? (
          <ScreenLoading label="Loading wikis" />
        ) : summaries.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="book-outline" size={30} color={c.textSecondary} />
            <Text style={[styles.empty, { color: c.textSecondary }]}>
              {connected
                ? 'No wikis yet. On the desktop, open the wiki panel for a project and run a build — the pages appear here.'
                : 'No cached wikis. Connect to your desktop once to fetch them — after that they stay readable offline.'}
            </Text>
          </View>
        ) : (
          <FadeIn>
            <ScrollView style={styles.list} contentContainerStyle={styles.body}>
              {summaries.map((s) => (
                <TouchableOpacity
                  key={s.path}
                  style={[styles.projectCard, { backgroundColor: c.surface2, borderColor: c.border }]}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Wiki for ${s.path.split(/[\\/]/).pop()}`}
                  onPress={() => openProject(s.path)}
                >
                  <View style={[styles.projectIcon, { backgroundColor: c.bubble }]}>
                    <Ionicons name="book-outline" size={16} color={c.accent} />
                  </View>
                  <View style={styles.projectText}>
                    <Text numberOfLines={1} style={[styles.projectName, { color: c.text }]}>
                      {s.path.split(/[\\/]/).filter(Boolean).pop()}
                    </Text>
                    <Text numberOfLines={1} style={{ color: c.textSecondary, fontSize: 11 }}>
                      {s.pageCount} pages{s.staleCount > 0 ? ` · ${s.staleCount} stale` : ''}
                      {s.builtAt ? ` · built ${timeAgo(s.builtAt)}` : ' · never built'}
                      {s.buildModel ? ` · ${s.buildModel}` : ''}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={15} color={c.textSecondary} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </FadeIn>
        )
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.md, padding: theme.spacing.xl },
  empty: { fontSize: 13, textAlign: 'center', lineHeight: 20 },
  body: { padding: theme.spacing.md, paddingBottom: 40 },
  list: { flex: 1 },
  backBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: theme.spacing.sm, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: '700' },
  projectCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: theme.radius.md, borderWidth: 1,
    padding: theme.spacing.md, marginBottom: theme.spacing.sm,
  },
  projectIcon: {
    width: 32, height: 32, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  projectText: { flex: 1 },
  projectName: { fontSize: 14, fontWeight: '700' },
  pageCard: {
    borderRadius: theme.radius.md, borderWidth: 1,
    padding: theme.spacing.md, marginBottom: theme.spacing.sm,
  },
  pageCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
  pageCardTitle: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  statusChip: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  pageBody: { padding: theme.spacing.md, paddingBottom: 48 },
  pageTitle: { fontSize: 20, fontWeight: '800', marginBottom: 6 },
  pageBrief: { fontSize: 13, lineHeight: 19, marginBottom: 10 },
  pageMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: theme.spacing.md },
  filesCard: {
    borderRadius: theme.radius.md, borderWidth: 1,
    padding: theme.spacing.md, marginTop: theme.spacing.lg,
  },
  filesTitle: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  fileRow: { fontSize: 11, fontFamily: 'monospace', paddingVertical: 1 },
  jobBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: theme.radius.md, borderWidth: 1,
    padding: theme.spacing.md, marginBottom: theme.spacing.sm,
  },
  actionsRow: { flexDirection: 'row', gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: theme.radius.pill, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: 'transparent',
  },
  flagsRow: { marginBottom: theme.spacing.md },
});
