# ade-pets

Realistic animated desktop pets for a React/TypeScript app (works in Tauri / Electron webviews).

Files
- `adePets.ts`   – the engine (plain three.js, no model files). Peer dependency: `three`.
- `PetCanvas.tsx` – tiny React wrapper: one pet in its own canvas.

Install
    npm i three
    npm i -D @types/three

One pet (React)
    import { PetCanvas } from './PetCanvas';
    <PetCanvas kind="cat" state={petState} size={220} />
    // kind:  'cat' | 'fox' | 'panda' | 'dragon' | 'axolotl' | 'robot'
    // state: 'idle' | 'strolling' | 'celebrating' | 'working' | 'sleeping'

Several pets, ONE WebGL context (recommended)
    import { PetStage } from './adePets';
    const stage = new PetStage({ canvas: myCanvas, quality: 'auto', fps: 30 });
    const a = stage.add('cat',   { element: divA, state: 'idle' });   // each pet is drawn into its element's rectangle
    const b = stage.add('robot', { element: divB, state: 'working' });
    stage.start();
    a.setState('celebrating');
    // later:  a.remove();  stage.dispose();

Driving it from your Rust/Tauri backend
    listen<string>('pet-state', e => pet.setState(e.payload as PetState));

Efficiency (built in)
- one GL context for all pets; 30 fps cap (15 fps when every pet is asleep); 'low-power' GPU hint
- nothing is drawn while the window is hidden, and pets whose element is off-screen cost nothing
- fur = one instanced draw call per body part (not one mesh per shell); small static pieces are merged
- 'auto' quality governor: starts at medium, steps down (thinner fur -> no shadows -> 1x pixel ratio) when frames
  get slow, and only steps back up after a long stable period. Force a level with quality: 'low' | 'medium' | 'high'.
- stage.stats -> { fps, calls, tris, level } for a debug overlay; stage.dispose() frees all GPU memory.
