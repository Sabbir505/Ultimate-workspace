/**
 * ProjectManager — phone-side projects CRUD (desktop sidebar parity). The
 * phone has no native folder picker, so adding a project takes the same
 * absolute path the desktop stores; the name defaults to the folder's last
 * segment. Rename and remove mirror the desktop row menus.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  Alert,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useRelay, type ProjectInfo } from '../hooks/useRelay';
import { useProjects } from '../hooks/useProjects';
import { tapLight } from '../lib/haptics';

export function ProjectManager({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = theme.colors;
  const { addProject, renameProject, removeProject } = useRelay();
  // listProjects send + ProjectList/Upserted/Removed merge — the shared
  // hook (same subscription the new-chat sheet uses).
  const projects = useProjects(visible);
  const [newPath, setNewPath] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const confirmRemove = (p: ProjectInfo) => {
    Alert.alert(
      `Remove “${p.name}”?`,
      'Its chats are removed from the desktop sidebar too. The folder on disk is untouched.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removeProject(p.id) },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: c.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
          <View style={styles.head}>
            <Text style={[styles.title, { color: c.text }]}>Projects</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Close projects"
            >
              <Ionicons name="close" size={20} color={c.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {projects.length === 0 ? (
              <Text style={[styles.empty, { color: c.textSecondary }]}>
                No projects yet. Add a folder below — chats started from it
                open with that working directory.
              </Text>
            ) : null}
            {projects.map((p) => (
              <View key={p.id} style={[styles.row, { backgroundColor: c.surface2 }]}>
                {renamingId === p.id ? (
                  <TextInput
                    style={[styles.renameInput, { color: c.text, borderColor: c.border }]}
                    value={renameText}
                    onChangeText={setRenameText}
                    autoFocus
                    accessibilityLabel={`Rename ${p.name}`}
                    onSubmitEditing={() => {
                      if (renameText.trim()) renameProject(p.id, renameText.trim());
                      setRenamingId(null);
                    }}
                  />
                ) : (
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                      {p.name}
                      {p.is_git_repo ? '  · git' : ''}
                    </Text>
                    <Text style={[styles.path, { color: c.textSecondary }]} numberOfLines={1}>
                      {p.path}
                    </Text>
                  </View>
                )}
                {renamingId === p.id ? (
                  <TouchableOpacity
                    onPress={() => {
                      if (renameText.trim()) renameProject(p.id, renameText.trim());
                      setRenamingId(null);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Save project name"
                  >
                    <Ionicons name="checkmark-circle" size={20} color={c.accent} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    onPress={() => { tapLight(); setRenamingId(p.id); setRenameText(p.name); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Rename ${p.name}`}
                  >
                    <Ionicons name="create-outline" size={17} color={c.textSecondary} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => confirmRemove(p)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${p.name}`}
                >
                  <Ionicons name="trash-outline" size={17} color={c.error} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>

          <View style={[styles.addRow, { borderTopColor: c.border }]}>
            <TextInput
              style={[styles.addInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
              placeholder="C:\\path\\to\\folder"
              placeholderTextColor={c.textSecondary}
              value={newPath}
              onChangeText={setNewPath}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Project folder path"
            />
            <TouchableOpacity
              style={[styles.addBtn, { backgroundColor: c.accent, opacity: newPath.trim() ? 1 : 0.4 }]}
              disabled={!newPath.trim()}
              accessibilityRole="button"
              accessibilityLabel="Add project"
              onPress={() => {
                addProject(newPath.trim());
                setNewPath('');
              }}
            >
              <Ionicons name="add" size={18} color={c.white} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    gap: 10,
    maxHeight: '80%',
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 16, fontWeight: '700' },
  list: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, padding: 12 },
  name: { fontSize: 14, fontWeight: '600' },
  path: { fontSize: 11, marginTop: 1 },
  renameInput: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14 },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 20 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
  addInput: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13 },
  addBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
});

export default ProjectManager;
