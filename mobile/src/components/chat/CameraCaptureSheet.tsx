/**
 * CameraCaptureSheet — full-screen camera modal for the composer's attach
 * menu ("Take photo"). Captures a single still with expo-camera and hands
 * the file:// URI back to the composer, which reads it as base64 (an
 * app-cache path, so the new FileSystem permission model allows it) and
 * attaches it as an image.
 *
 * Permission flow mirrors QrScanModal: a prompt with a grant button and an
 * open-settings fallback. The shutter is disabled while a capture is in
 * flight (takePictureAsync resolves with a cache URI).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';

const CameraViewAny = CameraView as unknown as React.ComponentType<{
  style?: import('react-native').ViewStyle;
  facing?: string;
  ref?: unknown;
}>;

interface CameraCaptureSheetProps {
  visible: boolean;
  /** Resolves with the captured photo's cache file:// URI. */
  onCaptured: (uri: string) => void;
  onClose: () => void;
}

export default function CameraCaptureSheet({ visible, onCaptured, onClose }: CameraCaptureSheetProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [shooting, setShooting] = useState(false);
  const cameraRef = React.useRef<React.ElementRef<typeof CameraView> | null>(null);
  const c = theme.colors;

  const takePhoto = async () => {
    if (shooting) return;
    setShooting(true);
    try {
      const camera = cameraRef.current as { takePictureAsync?: (opts: { quality: number }) => Promise<{ uri: string }> } | null;
      const photo = await camera?.takePictureAsync?.({ quality: 0.7 });
      if (photo?.uri) onCaptured(photo.uri);
    } finally {
      setShooting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={[styles.container, { backgroundColor: '#000' }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel="Close camera">
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Take photo</Text>
          <TouchableOpacity
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel="Flip camera"
          >
            <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
          </TouchableOpacity>
        </View>

        <View style={styles.cameraWrap}>
          {permission?.granted ? (
            <CameraViewAny
              ref={cameraRef as never}
              style={styles.camera}
              facing={facing}
            />
          ) : (
            <View style={styles.permissionBlock}>
              <Ionicons name="camera-outline" size={48} color={c.textSecondary} />
              <Text style={[styles.permissionText, { color: c.textSecondary }, theme.type.body]}>
                Camera access is required to take a photo.
              </Text>
              <TouchableOpacity
                style={[styles.permissionButton, { backgroundColor: c.accent }]}
                onPress={() => void requestPermission()}
              >
                <Text style={styles.permissionButtonText}>Grant camera access</Text>
              </TouchableOpacity>
              {permission && !permission.granted && (
                <TouchableOpacity
                  style={[styles.permissionButton, { borderColor: c.border, borderWidth: 1 }]}
                  onPress={() => void Linking.openSettings()}
                >
                  <Text style={[styles.permissionButtonText, { color: c.text }]}>Open settings</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {permission?.granted ? (
            <View style={styles.shutterRow} pointerEvents="box-none">
              <TouchableOpacity
                style={[styles.shutter, shooting && styles.shutterBusy]}
                onPress={() => void takePhoto()}
                disabled={shooting}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Take photo"
              >
                {shooting
                  ? <ActivityIndicator color="#fff" />
                  : <View style={styles.shutterInner} />}
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md, paddingVertical: 10,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cameraWrap: { flex: 1, position: 'relative' },
  camera: { flex: 1 },
  shutterRow: {
    position: 'absolute', left: 0, right: 0, bottom: 34,
    alignItems: 'center',
  },
  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.6 },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  permissionBlock: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md,
  },
  permissionText: { textAlign: 'center' },
  permissionButton: {
    paddingVertical: 14, paddingHorizontal: theme.spacing.lg, borderRadius: theme.radius.md,
  },
  permissionButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
