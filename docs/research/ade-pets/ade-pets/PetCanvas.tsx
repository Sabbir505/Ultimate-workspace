import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { PetStage } from './adePets';
import type { PetKind, PetState, QualityMode } from './adePets';

export interface PetCanvasProps {
  kind: PetKind;
  state?: PetState;
  /** square size in CSS pixels (default 240) */
  size?: number;
  /** 'auto' (default) lowers fur/shadow/resolution by itself if frames get slow */
  quality?: QualityMode;
  /** frame-rate cap (default 30) */
  fps?: number;
  className?: string;
  style?: CSSProperties;
}

/** One pet in its own canvas. For several pets, create one PetStage yourself and call stage.add() per pet (one GL context). */
export function PetCanvas({ kind, state = 'idle', size = 240, quality = 'auto', fps = 30, className, style }: PetCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<PetStage | null>(null);
  const pet = useRef<ReturnType<PetStage['add']> | null>(null);

  // (re)create only when the animal or the fps cap changes
  useEffect(() => {
    const el = host.current!;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    el.appendChild(canvas);
    const s = new PetStage({ canvas, quality, fps });
    stage.current = s;
    pet.current = s.add(kind, { element: canvas, state });
    s.start();
    return () => {
      s.dispose();
      if (canvas.parentNode === el) el.removeChild(canvas);
      stage.current = null;
      pet.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, fps]);

  useEffect(() => { pet.current?.setState(state); }, [state]);
  useEffect(() => { stage.current?.setQuality(quality); }, [quality]);

  return <div ref={host} className={className} style={{ width: size, height: size, ...style }} />;
}
