import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';

// React 19's @types/react changes Component<P> overload resolution so
// that expo-camera's CameraView loses its prop types in JSX. Cast the
// component to a permissive type until expo-camera ships fixed types.
const CameraViewAny = CameraView as unknown as React.ComponentType<{
  style?: import('react-native').ViewStyle;
  facing?: string;
  barcodeScannerEnabled?: boolean;
  onBarcodeScanned?: (result: { data: string }) => void;
}>;

interface QrScanModalProps {
  visible: boolean;
  onScanned: (url: string) => void;
  onClose: () => void;
}

/**
 * Full-screen QR scanner modal. Uses expo-camera's CameraView with
 * barcodeScannerEnabled to detect QR codes. When a code is scanned, the
 * payload is passed to `onScanned` (expected to be a `ws://` or `wss://`
 * URL with a `#token` fragment) and the modal closes.
 *
 * Permission flow: if the camera permission is not granted, the modal shows
 * a prompt with a button to request permission or open settings.
 */
export default function QrScanModal({ visible, onScanned, onClose }: QrScanModalProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const c = theme.colors;
  const scannedRef = useRef(false);

  // Reset the "already scanned" guard each time the modal opens.
  useEffect(() => {
    if (visible) scannedRef.current = false;
  }, [visible]);

  const handleBarcodeScanned = (result: { data: string }) => {
    if (scannedRef.current) return;
    const data = result?.data;
    if (!data || !(data.startsWith('ws://') || data.startsWith('wss://'))) return;
    scannedRef.current = true;
    onScanned(data);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={[styles.container, { backgroundColor: c.background }]}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={c.text} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: c.text }]}>Scan Pairing QR</Text>
          <View style={styles.closeButton} />
        </View>

        <View style={styles.cameraWrap}>
          {permission?.granted ? (
            <CameraViewAny
              style={styles.camera}
              facing="back"
              barcodeScannerEnabled={true}
              onBarcodeScanned={handleBarcodeScanned}
            />
          ) : (
            <View style={styles.permissionBlock}>
              <Ionicons name="camera" size={48} color={c.textSecondary} />
              <Text style={[styles.permissionText, { color: c.textSecondary }]}>
                Camera access is required to scan the pairing QR code.
              </Text>
              <TouchableOpacity
                style={[styles.permissionButton, { backgroundColor: c.primary }]}
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

          {/* Scan frame overlay */}
          {permission?.granted && (
            <View style={styles.scanOverlay} pointerEvents="none">
              <View style={[styles.scanFrame, { borderColor: c.primary }]} />
              <Text style={[styles.scanHint, { color: '#fff' }]}>
                Point at the QR code on the desktop's Remote settings panel
              </Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1,
  },
  closeButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 17, fontWeight: '700' },
  cameraWrap: { flex: 1, position: 'relative' },
  camera: { flex: 1 },
  scanOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
  },
  scanFrame: {
    width: 240, height: 240, borderWidth: 2, borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scanHint: {
    position: 'absolute', bottom: 60, fontSize: 13, textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 8, overflow: 'hidden',
  },
  permissionBlock: {
    flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16,
  },
  permissionText: {
    fontSize: 15, textAlign: 'center', lineHeight: 22,
  },
  permissionButton: {
    paddingVertical: 14, paddingHorizontal: 24, borderRadius: 12, alignItems: 'center',
  },
  permissionButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
