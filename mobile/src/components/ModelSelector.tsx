import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  Pressable,
  TextInput,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const ChevronDown = ({ size, color }: { size?: number; color?: string; style?: object }) => <Ionicons name="chevron-down" size={size} color={color} />;
const Check = ({ size, color }: { size?: number; color?: string; style?: object }) => <Ionicons name="checkmark" size={size} color={color} />;
const Search = ({ size, color }: { size?: number; color?: string; style?: object }) => <Ionicons name="search" size={size} color={color} />;
const X = ({ size, color }: { size?: number; color?: string; style?: object }) => <Ionicons name="close" size={size} color={color} />;
const Cpu = ({ size, color }: { size?: number; color?: string; style?: object }) => <Ionicons name="hardware-chip" size={size} color={color} />;
import { theme } from '../theme';
import { ProviderInfo } from '../hooks/useRelay';

/** A flattened search-result row (search crosses provider + model names). */
type SearchRow = { provider: ProviderInfo; model: string; key: string };

interface ModelSelectorProps {
  providers: ProviderInfo[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, model: string, ggufPath?: string) => void;
}

/** A provider row + its models, expanded/collapsed on tap. */
function ProviderSection({
  provider,
  expanded,
  onToggle,
  selectedProvider,
  selectedModel,
  onSelect,
  colors,
}: {
  provider: ProviderInfo;
  expanded: boolean;
  onToggle: () => void;
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, model: string, ggufPath?: string) => void;
  colors: typeof theme.colors;
}) {
  const isLocal = !!provider.is_local;
  const isRunning = !!provider.is_running;
  // Stopped local models are NOT disabled here: tapping one sends a
  // StartLocalModel message so the desktop spawns the sidecar on demand.
  const models = provider.models || [];
  const matchCount = models.length;

  return (
    <View style={[styles.providerSection, { borderColor: colors.border }]}>
      <TouchableOpacity
        style={[styles.providerRow, { backgroundColor: colors.background }]}
        onPress={onToggle}
        activeOpacity={0.6}
      >
        {isLocal ? (
          <Cpu size={16} color={isRunning ? colors.success : colors.gray} />
        ) : (
          <View style={[styles.cloudDot, { backgroundColor: colors.primary }]} />
        )}
        <Text style={[styles.providerName, { color: colors.text }]} numberOfLines={1}>
          {provider.display_name}
        </Text>
        <Text style={[styles.providerCount, { color: colors.textSecondary }]}>
          {matchCount}
        </Text>
        {isLocal && (
          <View style={[
            styles.localBadge,
            !isRunning && { backgroundColor: 'rgba(158, 158, 158, 0.12)' },
          ]}>
            <Text style={[
              styles.localBadgeText,
              { color: isRunning ? colors.success : colors.gray },
            ]}>
              {isRunning ? 'Local' : 'Stopped'}
            </Text>
          </View>
        )}
        <ChevronDown
          size={18}
          color={colors.textSecondary}
          style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.modelList}>
          {models.length === 0 ? (
            <Text style={[styles.emptyModel, { color: colors.textSecondary }]}>
              No models available
            </Text>
          ) : (
            models.map((model) => {
              const isSelected =
                provider.id === selectedProvider && model === selectedModel;
              return (
                <TouchableOpacity
                  key={model}
                  style={[
                    styles.modelItem,
                    { backgroundColor: colors.background },
                    isSelected && { backgroundColor: 'rgba(193, 95, 60, 0.12)' },
                  ]}
                  onPress={() => onSelect(provider.id, model, provider.gguf_path)}
                >
                  <Text
                    style={[
                      styles.modelText,
                      { color: colors.text },
                      isSelected && { color: colors.primary, fontWeight: '600' },
                      !isRunning && { color: colors.textSecondary },
                    ]}
                    numberOfLines={1}
                  >
                    {model}
                  </Text>
                  {isSelected && <Check size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            })
          )}
        </View>
      )}
    </View>
  );
}

/** Flat search-result row: "Provider · model". */
function SearchResultRow({
  provider,
  model,
  isSelected,
  onSelect,
  colors,
}: {
  provider: ProviderInfo;
  model: string;
  isSelected: boolean;
  onSelect: () => void;
  colors: typeof theme.colors;
}) {
  // Stopped local models remain tappable: selecting one triggers a
  // StartLocalModel warm-up on the desktop.
  return (
    <TouchableOpacity
      style={[
        styles.modelItem,
        { backgroundColor: colors.background },
        isSelected && { backgroundColor: 'rgba(193, 95, 60, 0.12)' },
      ]}
      onPress={onSelect}
    >
      <View style={{ flex: 1 }}>
        <Text
          style={[
            styles.modelText,
            { color: provider.is_local && !provider.is_running ? colors.textSecondary : colors.text },
            isSelected && { color: colors.primary, fontWeight: '600' },
          ]}
          numberOfLines={1}
        >
          {model}
        </Text>
        <Text style={[styles.modelSub, { color: colors.textSecondary }]} numberOfLines={1}>
          {provider.display_name}{provider.is_local ? (provider.is_running ? ' · Local' : ' · Stopped') : ''}
        </Text>
      </View>
      {isSelected && <Check size={18} color={colors.primary} />}
    </TouchableOpacity>
  );
}

export default function ModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
}: ModelSelectorProps) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  // Expanded providers keyed by `id + gguf_path` (multiple local_gguf entries
  // share an id, so the path disambiguates them).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const c = theme.colors;

  // The provider that owns the current selection. For local_gguf, several
  // providers share the id (one per GGUF file), so match on the model name.
  const currentProvider =
    providers.find(p => p.id === selectedProvider && (p.models || []).includes(selectedModel)) ??
    providers.find(p => p.id === selectedProvider);
  const displayText = currentProvider
    ? `${currentProvider.display_name} / ${selectedModel}`
    : providers.length > 0
      ? 'Select model…'
      : 'No models available';

  const handleSelect = (providerId: string, model: string, ggufPath?: string) => {
    onSelect(providerId, model, ggufPath);
    setVisible(false);
    setQuery('');
  };

  // When the modal opens with no query, auto-expand the provider that owns the
  // currently selected model so the user sees context immediately.
  const ensureInitialExpand = () => {
    setExpanded(prev => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, boolean> = {};
      for (const p of providers) {
        const key = p.id + (p.gguf_path ?? '');
        if (p.id === selectedProvider && (p.models || []).some(m => m === selectedModel)) {
          next[key] = true;
        }
      }
      return next;
    });
  };

  // Flat search results across providers + models.
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out: Array<{ provider: ProviderInfo; model: string; key: string }> = [];
    for (const p of providers) {
      const providerMatch = (p.display_name || '').toLowerCase().includes(q);
      for (const m of (p.models || [])) {
        if (providerMatch || m.toLowerCase().includes(q)) {
          out.push({ provider: p, model: m, key: p.id + (p.gguf_path ?? '') + '|' + m });
        }
      }
    }
    return out;
  }, [query, providers]);

  const flatData: Array<ProviderInfo | SearchRow> = useMemo(() => {
    if (searchResults) return searchResults;
    // Provider list — selected provider sorted first for quick access.
    return [...providers].sort((a, b) => {
      const aSel = a.id === selectedProvider ? 0 : 1;
      const bSel = b.id === selectedProvider ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
      return 0;
    });
  }, [searchResults, providers, selectedProvider]);

  const keyFor = (p: ProviderInfo) => p.id + (p.gguf_path ?? '');

  return (
    <>
      <TouchableOpacity
        style={[styles.button, { backgroundColor: c.surface, borderColor: c.border }]}
        onPress={() => { setVisible(true); ensureInitialExpand(); }}
      >
        <Text style={[styles.buttonText, { color: c.text }]} numberOfLines={1} ellipsizeMode="tail">
          {displayText}
        </Text>
        <ChevronDown size={18} color={c.textSecondary} />
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={() => setVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setVisible(false)}>
          <Pressable
            style={[styles.modal, { backgroundColor: c.background }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={[styles.modalHeader, { borderBottomColor: c.border }]}>
              <Text style={[styles.modalTitle, { color: c.text }]}>Select Model</Text>
              <TouchableOpacity onPress={() => setVisible(false)}>
                <Text style={[styles.closeButton, { color: c.primary }]}>Done</Text>
              </TouchableOpacity>
            </View>

            {/* Search */}
            <View style={[styles.searchRow, { borderBottomColor: c.border }]}>
              <Search size={16} color={c.textSecondary} />
              <TextInput
                style={[styles.searchInput, { color: c.text }]}
                placeholder="Search providers and models…"
                placeholderTextColor={c.textSecondary}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
              {query.length > 0 && (
                <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                  <X size={16} color={c.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            <FlatList
              data={flatData}
              keyExtractor={(item) => searchResults ? (item as SearchRow).key : keyFor(item as ProviderInfo)}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyText, { color: c.textSecondary }]}>
                    {providers.length === 0
                      ? 'No providers available — connect to your desktop or configure a provider in Settings.'
                      : 'No models match your search.'}
                  </Text>
                </View>
              }
              renderItem={({ item }) => {
                if (searchResults) {
                  const r = item as SearchRow;
                  const isSelected =
                    r.provider.id === selectedProvider && r.model === selectedModel;
                  return (
                    <SearchResultRow
                      provider={r.provider}
                      model={r.model}
                      isSelected={isSelected}
                      onSelect={() => handleSelect(r.provider.id, r.model, r.provider.gguf_path)}
                      colors={c}
                    />
                  );
                }
                const provider = item as ProviderInfo;
                const key = keyFor(provider);
                return (
                  <ProviderSection
                    provider={provider}
                    expanded={!!expanded[key]}
                    onToggle={() =>
                      setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
                    }
                    selectedProvider={selectedProvider}
                    selectedModel={selectedModel}
                    onSelect={handleSelect}
                    colors={c}
                  />
                );
              }}
              contentContainerStyle={styles.listContent}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: 8,
    maxWidth: 220,
  },
  buttonText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modal: {
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    maxHeight: '82%',
    paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing.lg,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
  },
  closeButton: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.md,
    paddingVertical: 4,
  },
  listContent: {
    padding: theme.spacing.md,
  },
  // provider (collapsible) section
  providerSection: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
    marginBottom: theme.spacing.sm,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
    gap: 10,
  },
  cloudDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  providerName: {
    flex: 1,
    fontSize: theme.fontSize.md,
    fontWeight: '600',
  },
  providerCount: {
    fontSize: 11,
    fontWeight: '700',
  },
  localBadge: {
    backgroundColor: 'rgba(76, 175, 80, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  localBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  modelList: {
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: 8,
    gap: 2,
  },
  emptyModel: {
    fontSize: theme.fontSize.sm,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.md,
  },
  // model row (shared by both modes)
  modelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.borderRadius.md,
  },
  modelItemDisabled: {
    opacity: 0.45,
  },
  modelText: {
    flex: 1,
    fontSize: theme.fontSize.md,
  },
  modelSub: {
    fontSize: 11,
    marginTop: 2,
  },
  emptyState: {
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
});
