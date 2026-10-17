// @ts-nocheck — ported verbatim from docs/research/ade-pets (the engine is
// hand-tuned, minified-style JS; type-checking it buys nothing and the public
// surface is typed by the wrappers in stage.ts / PetAvatar.tsx).
// Loaded lazily (dynamic import) so three.js + the engine stay out of the
// entry chunk — see src/lib/pets/stage.ts.
/**
 * adePets.ts — realistic animated desktop pets (cat, fox, panda, dragon, axolotl, robot) for three.js.
 * No model files or textures: everything is generated in code. Peer dependency: three (r150 – r170 tested API).
 *
 *   const stage = new PetStage({ canvas, quality: 'auto', fps: 30 });
 *   const cat = stage.add('cat', { element: someDiv, state: 'idle' });   // drawn into someDiv's rectangle
 *   cat.setState('celebrating');                                          // idle | strolling | celebrating | working | sleeping
 *   stage.start();   ...   stage.dispose();
 *
 * Efficiency: one WebGL context for any number of pets, 30 fps cap (15 when everything sleeps), nothing drawn while the
 * window is hidden or a pet is off-screen, 'low-power' GPU hint, instanced fur (one draw call per body part) and an
 * automatic quality governor that steps fur/shadows/resolution down if frames get slow.
 */
import * as T from 'three';

export type PetKind = 'cat' | 'fox' | 'panda' | 'dragon' | 'axolotl' | 'robot';
export type PetState = 'idle' | 'strolling' | 'celebrating' | 'working' | 'sleeping';
export type QualityMode = 'auto' | 'low' | 'medium' | 'high';
/** Lighting preset. `auto` follows the render-quality level (see LIGHTING). */
export type LightingMode = 'auto' | 'low' | 'medium' | 'high';

const mat=(c,o={})=>new T.MeshPhysicalMaterial({color:c,roughness:o.rg??(typeof o.r==='number'?o.r:.65),metalness:o.m??0,emissive:o.g?c:0x000000,emissiveIntensity:o.g||0,transparent:(o.o??1)<1,opacity:o.o??1});
const mesh=(geo,c,o={})=>{const m=new T.Mesh(geo,mat(c,o));if(o.p)m.position.set(...o.p);if(o.s!=null)Array.isArray(o.s)?m.scale.set(...o.s):m.scale.setScalar(o.s);if(Array.isArray(o.r))m.rotation.set(...o.r);return m};
const sph=(c,o)=>{const q=o&&o.s!=null?(Array.isArray(o.s)?Math.max(...o.s):o.s):1;return mesh(new T.SphereGeometry(1,q<.08?12:q<.2?20:32,q<.08?8:q<.2?14:24),c,o)}, cap=(r,l,c,o)=>mesh(new T.CapsuleGeometry(r,l,8,16),c,o),
cone=(r,h,c,o)=>mesh(new T.ConeGeometry(r,h,r<.04?10:24),c,o), box=(w,h,d,c,o)=>mesh(new T.BoxGeometry(w,h,d),c,o),
cyl=(r,h,c,o)=>mesh(new T.CylinderGeometry(r,r,h,r<.02?6:24),c,o);
const grp=(p,...k)=>{const g=new T.Group();if(p)g.position.set(...p);k.forEach(x=>x&&g.add(x));return g};

const surf=(c,R,az,el,k=1)=>[c[0]+R[0]*Math.cos(el)*Math.sin(az)*k,c[1]+R[1]*Math.sin(el)*k,c[2]+R[2]*Math.cos(el)*Math.cos(az)*k];

function rbox(w,h,d,r,c,o){const b=Math.min(r*.6,w/4,h/4,d/4),cr=Math.max(r-b,.001),x=w/2-b,y=h/2-b,s=new T.Shape(),P=Math.PI;
s.moveTo(-x+cr,-y);s.lineTo(x-cr,-y);s.absarc(x-cr,-y+cr,cr,-P/2,0,false);s.lineTo(x,y-cr);s.absarc(x-cr,y-cr,cr,0,P/2,false);
s.lineTo(-x+cr,y);s.absarc(-x+cr,y-cr,cr,P/2,P,false);s.lineTo(-x,-y+cr);s.absarc(-x+cr,-y+cr,cr,P,P*1.5,false);
const g=new T.ExtrudeGeometry(s,{depth:d-2*b,bevelEnabled:true,bevelThickness:b,bevelSize:b,bevelSegments:4,curveSegments:8});g.center();return mesh(g,c,o)}
function limb(p,side,r,len,c,tipC,foot,splay=0){const t=len+2*r,g=grp(p,cap(r,len,c,{p:[0,-t/2,0]}),
foot?sph(tipC,{s:[r*1.15,.1,r*1.45],p:[0,-t+.1,.05]}):sph(tipC,{s:r*1.1,p:[0,-t+.02,0]}));g.rotation.z=side*splay;g.userData.sz=side*splay;return g}
/* merge static child meshes of `parent` into ONE vertex-coloured mesh (fewer draw calls) */
function bake(parent,list,o={}){const P=[],N=[],Cl=[],I=[];let off=0;
for(const m of list){const g=m.geometry,pa=g.attributes&&g.attributes.position,na=g.attributes&&g.attributes.normal;if(!pa||!na)continue;
const vc=g.attributes.color,mc=m.material.color,a=m.rotation.x,b=m.rotation.y,cz=m.rotation.z,ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b),cc=Math.cos(cz),sc=Math.sin(cz),
r0=[cb*cc,-cb*sc,sb],r1=[ca*sc+sa*sb*cc,ca*cc-sa*sb*sc,-sa*cb],r2=[sa*sc-ca*sb*cc,sa*cc+ca*sb*sc,ca*cb],sx=m.scale.x,sy=m.scale.y,sz=m.scale.z,ps=m.position;
for(let i=0;i<pa.count;i++){const x=pa.getX(i)*sx,y=pa.getY(i)*sy,z=pa.getZ(i)*sz;
P.push(r0[0]*x+r0[1]*y+r0[2]*z+ps.x,r1[0]*x+r1[1]*y+r1[2]*z+ps.y,r2[0]*x+r2[1]*y+r2[2]*z+ps.z);
const nx=na.getX(i)/sx,ny=na.getY(i)/sy,nz=na.getZ(i)/sz,qx=r0[0]*nx+r0[1]*ny+r0[2]*nz,qy=r1[0]*nx+r1[1]*ny+r1[2]*nz,qz=r2[0]*nx+r2[1]*ny+r2[2]*nz,l=Math.hypot(qx,qy,qz)||1;N.push(qx/l,qy/l,qz/l);
if(vc)Cl.push(vc.getX(i),vc.getY(i),vc.getZ(i));else Cl.push(mc.r,mc.g,mc.b)}
const ix=g.index;if(ix)for(let i=0;i<ix.count;i++)I.push(ix.getX(i)+off);else for(let i=0;i<pa.count;i++)I.push(i+off);
off+=pa.count;parent.remove(m)}
if(!P.length)return null;const bg=new T.BufferGeometry();bg.setAttribute('position',new T.Float32BufferAttribute(P,3));bg.setAttribute('normal',new T.Float32BufferAttribute(N,3));bg.setAttribute('color',new T.Float32BufferAttribute(Cl,3));bg.setIndex(I);
const bm=new T.Mesh(bg,new T.MeshPhysicalMaterial({vertexColors:true,roughness:o.rough??.7}));bm.castShadow=bm.receiveShadow=true;parent.add(bm);return bm}
function limb2(p,side,r,len,c,tipC,foot,splay,toes){const g=limb(p,side,r,len,c,tipC,foot,splay);if(toes){const t=len+2*r;for(let i=-1;i<2;i++)g.add(sph(tipC,{s:.035,p:[i*(foot?.08:.06),-t+(foot?.1:-.02),foot?.17:.1]}))}return g}
function eye(p,w=.075,h=.1){return grp(p,sph('#1c2033',{s:[w,h,w*.7],r:.25}),sph('#fff',{s:w*.38,p:[w*.35,h*.4,w*.5],g:.6}))}
function shadowMesh(){const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d'),gr=g.createRadialGradient(64,64,0,64,64,64);
gr.addColorStop(0,'rgba(0,0,0,.5)');gr.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=gr;g.fillRect(0,0,128,128);
const m=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({map:new T.CanvasTexture(c),transparent:true,depthWrite:false}));m.rotation.x=-Math.PI/2;m.position.y=.01;return m}
function Axolotl2(){const P='#ff9ec4',L='#ffd9e8',D='#ff6fa5',DD='#ff5a8f',SP='#e8729f',O=.4,r={gills:[]};
r.bl=limb2([-.25,.42,0],-1,.13,.15,P,L,true,0,true);r.br=limb2([.25,.42,0],1,.13,.15,P,L,true,0,true);
r.fl=limb2([-.55,1,.02],-1,.09,.2,P,L,false,.2,true);r.fr=limb2([.55,1,.02],1,.09,.2,P,L,false,.2,true);
r.tail=grp([0,.55,-.42]);const segs=[];let par=r.tail;
for(let i=0;i<3;i++){const rr=.16-i*.035,g=grp(i?[0,0,-.3]:null,cap(rr,.14,P,{p:[0,0,-.12],r:[-Math.PI/2,0,0],s:[1.15,1,.5],rg:O}),sph(D,{s:[.022,.16-i*.03,.2],p:[0,.1,-.12],rg:O}));par.add(g);segs.push(g);par=g}
const gill=()=>{const g=grp(null,cap(.05,.3,DD,{p:[.22,0,0],r:[0,0,Math.PI/2],rg:O}),sph(DD,{s:.06,p:[.46,0,0]}));
for(let k=0;k<4;k++)for(const sg of[-1,1])g.add(cap(.02,.1,'#ff7fae',{p:[.1+k*.1,sg*.06,0],r:[0,0,Math.PI/2+sg*.7]}));bake(g,g.children.slice(),{rough:.45});return g};
const gl=[-1,1].map(s=>{const g=grp([s*.84,.42,-.05]);g.scale.x=s;for(let i=0;i<3;i++){const f=grp(null,gill());f.rotation.z=(i-1)*.55;f.userData.base=(i-1)*.55;r.gills.push(f);g.add(f)}return g});
const HC=[0,.36,0],HR=[1,.55,.72];
const spots=[[-.5,.9],[.3,1],[.7,.7],[-.1,.5],[-.9,.5],[.1,1.2]].map(([a,e])=>sph(SP,{s:.04,p:surf(HC,HR,a,e,.98)}));
const spotG=grp(null,...spots);bake(spotG,spotG.children.slice(),{rough:.6});
r.eyeL=eye([-.46,.44,.6],.075,.095);r.eyeR=eye([.46,.44,.6],.075,.095);
r.head=grp([0,1.25,.05],sph(P,{s:HR,p:HC,rg:O}),...gl,spotG,sph(D,{s:[.02,.1,.28],p:[0,.93,-.1]}),r.eyeL,r.eyeR,
mesh(new T.TorusGeometry(.1,.014,8,24,Math.PI),'#c0457a',{p:[0,.3,.695],r:[0,0,Math.PI]}),
sph('#7a2a4f',{s:.018,p:[-.07,.38,.71]}),sph('#7a2a4f',{s:.018,p:[.07,.38,.71]}),
...[-1,1].map(s=>sph('#ff7aa8',{s:[.09,.06,.03],p:surf(HC,HR,s*.7,-.15,1),o:.85})));
const bs=[[-.9,.6],[.8,.3],[.5,.9],[-.6,.1],[1,.7]].map(([a,e])=>sph(SP,{s:.035,p:surf([0,.75,0],[.64,.5,.52],a,e,.98)}));
const bsG=grp(null,...bs);bake(bsG,bsG.children.slice(),{rough:.6});
r.bobKids=[r.bl,r.br,r.tail,sph(P,{s:[.64,.5,.52],p:[0,.75,0],rg:O}),sph(P,{s:[.55,.45,.46],p:[0,1,0],rg:O}),sph(L,{s:[.4,.4,.14],p:[0,.8,.43],rg:O}),bsG,r.fl,r.fr,r.head];
return {r,size:2,desk:[.78,.4],reach:-1.2,swing:.6,update(t,s){const sp=s==='celebrating'?9:s==='strolling'?6:2.5;segs.forEach((g,i)=>g.rotation.y=Math.sin(t*sp-i*.9)*.3)}}}
function Robot(){const S='#c9d3e6',K='#2a3350',C='#5df0ff',r={};
r.bl=limb([-.28,.5,0],-1,.14,.2,S,K,true);r.br=limb([.28,.5,0],1,.14,.2,S,K,true);
r.fl=limb([-.68,1.25,.02],-1,.1,.3,S,K,false,.14);r.fr=limb([.68,1.25,.02],1,.1,.3,S,K,false,.14);
const mk=x=>grp([x,.54,.52],cap(.06,.1,C,{g:1.4,r:.3}));r.eyeL=mk(-.25);r.eyeR=mk(.25);
r.bulb=sph(C,{s:.09,p:[0,1.3,0],g:1});
r.head=grp([0,1.5,.02],rbox(1.25,.95,.95,.22,S,{p:[0,.5,0],r:.35,m:.15}),rbox(1,.62,.1,.08,'#0b1224',{p:[0,.52,.44],r:.15}),r.eyeL,r.eyeR,
box(.2,.035,.02,C,{p:[0,.34,.5],g:1}),...[-1,1].map(s=>cyl(.13,.14,K,{p:[s*.66,.5,0],r:[0,0,Math.PI/2]})),cyl(.025,.3,K,{p:[0,1.12,0]}),r.bulb);
r.bobKids=[r.bl,r.br,rbox(1,.85,.7,.14,S,{p:[0,1,0],r:.4,m:.15}),rbox(.6,.34,.06,.05,K,{p:[0,1.02,.36]}),
...['#ff6b9d','#ffd166','#80ed99'].map((c,i)=>sph(c,{s:.045,p:[-.18+i*.18,1.02,.4],g:1.2})),r.fl,r.fr,r.head];
return {r,size:1.9,desk:[.95,.5],reach:-1.25,swing:.5}}
/* ---- realism: environment lighting, fur shells, glossy coats ---- */
let noiseTex;
function noise(){if(noiseTex)return noiseTex;const c=document.createElement('canvas');c.width=c.height=48;const g=c.getContext('2d'),d=g.createImageData(48,48);
for(let i=0;i<d.data.length;i+=4){const v=Math.random()*255;d.data[i]=d.data[i+1]=d.data[i+2]=v;d.data[i+3]=255}g.putImageData(d,0,0);
noiseTex=new T.CanvasTexture(c);noiseTex.wrapS=noiseTex.wrapT=T.RepeatWrapping;noiseTex.repeat.set(1,1);return noiseTex}

function makeEnv(rd){const sc=new T.Scene(),geo=new T.SphereGeometry(20,32,16),pos=geo.attributes.position,col=[],
top=new T.Color('#dfe9ff').multiplyScalar(.9),bot=new T.Color('#5a5f78').multiplyScalar(.6),mid=new T.Color('#ffffff').multiplyScalar(.7);
for(let i=0;i<pos.count;i++){const y=pos.getY(i)/20,c=y>0?mid.clone().lerp(top,y):mid.clone().lerp(bot,-y);col.push(c.r,c.g,c.b)}
geo.setAttribute('color',new T.Float32BufferAttribute(col,3));sc.add(new T.Mesh(geo,new T.MeshBasicMaterial({vertexColors:true,side:T.BackSide})));
const panel=(w,h,c,k,p)=>{const m=new T.Mesh(new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({color:new T.Color(c).multiplyScalar(k),side:T.DoubleSide}));m.position.set(...p);m.lookAt(0,1,0);sc.add(m)};
panel(9,6,'#fff6ea',6,[8,9,10]);panel(7,5,'#9cc7ff',3,[-10,4,-8]);panel(10,3,'#ffd9b0',1.5,[0,-6,8]);
const pm=new T.PMREMGenerator(rd),tex=pm.fromScene(sc,.03).texture;pm.dispose();return tex}
function realism(root){root.traverse(o=>{if(!o.isMesh||o.userData.shell||!o.material)return;const m=o.material;o.castShadow=!m.transparent;o.receiveShadow=true;
if(m.roughness<=.45){m.clearcoat=.8;m.clearcoatRoughness=.1}else if(m.roughness<=.6){m.clearcoat=.3;m.clearcoatRoughness=.3}})}


/* ---- realistic quadrupeds: lofted anatomy, painted coats, fur shells ---- */
const C=h=>new T.Color(h),sm=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)},MIXC=(a,b,t)=>a.clone().lerp(b,Math.max(0,Math.min(1,t)));
function loft(st,seg,den,sub,ck){sub=sub||2;ck=ck||5;
const sb=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],ad=(a,b,k)=>[a[0]+b[0]*k,a[1]+b[1]*k,a[2]+b[2]*k],nm=v=>{const l=Math.hypot(v[0],v[1],v[2])||1;return[v[0]/l,v[1]/l,v[2]/l]},cr=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const n=st.length,ra=s=>(s.rx+s.ry)/2,E=[];
for(let i=0;i<n-1;i++)for(let k=0;k<sub;k++){const u=k/sub,a=st[i],b=st[i+1];E.push({p:[a.p[0]+(b.p[0]-a.p[0])*u,a.p[1]+(b.p[1]-a.p[1])*u,a.p[2]+(b.p[2]-a.p[2])*u],rx:a.rx+(b.rx-a.rx)*u,ry:a.ry+(b.ry-a.ry)*u})}
E.push(st[n-1]);const ne=E.length,t0=nm(sb(E[1].p,E[0].p)),t1=nm(sb(E[ne-1].p,E[ne-2].p)),R=[];
for(let i=ck;i>=1;i--){const th=i/ck*Math.PI/2,sc=Math.max(Math.cos(th),.03);R.push({p:ad(E[0].p,t0,-Math.sin(th)*ra(E[0])),rx:E[0].rx*sc,ry:E[0].ry*sc})}
E.forEach(s=>R.push({p:s.p,rx:s.rx,ry:s.ry}));
for(let i=1;i<=ck;i++){const th=i/ck*Math.PI/2,sc=Math.max(Math.cos(th),.03);R.push({p:ad(E[ne-1].p,t1,Math.sin(th)*ra(E[ne-1])),rx:E[ne-1].rx*sc,ry:E[ne-1].ry*sc})}
const m=R.length,V=seg+1,pos=new Float32Array(m*V*3),uv=new Float32Array(m*V*2),idx=new Uint16Array((m-1)*seg*6);let arc=0,a0=0;
for(let i=0;i<m;i++){const A=R[Math.max(i-1,0)],B=R[Math.min(i+1,m-1)],t=nm(sb(B.p,A.p));
if(i)arc+=Math.hypot(...sb(R[i].p,R[i-1].p));if(i===ck)a0=arc;
const ref=Math.abs(t[1])>.92?[0,0,1]:[0,1,0],S=nm(cr(ref,t)),U=cr(t,S),r=R[i],per=2*Math.PI*(r.rx+r.ry)/2;
for(let j=0;j<V;j++){const a=j/seg*2*Math.PI,k=i*V+j,c=Math.cos(a)*r.rx,s=Math.sin(a)*r.ry;
pos[k*3]=r.p[0]+S[0]*c+U[0]*s;pos[k*3+1]=r.p[1]+S[1]*c+U[1]*s;pos[k*3+2]=r.p[2]+S[2]*c+U[2]*s;uv[k*2]=j/seg*per*den;uv[k*2+1]=arc*den}}
for(let i=0;i<m;i++)for(let j=0;j<V;j++)uv[(i*V+j)*2+1]-=a0*den;
let q=0;for(let i=0;i<m-1;i++)for(let j=0;j<seg;j++){const a=i*V+j,b=a+1,c=a+V,d=c+1;idx[q++]=a;idx[q++]=b;idx[q++]=c;idx[q++]=b;idx[q++]=d;idx[q++]=c}
return {pos,uv,idx}}
/* fur: ONE instanced draw per body part; each instance is a shell pushed out along the normal in the vertex shader */
const FUR_TIME={value:0},furMats={};let FUR_REG=null;
function furTime(t){FUR_TIME.value=t}
function furMat(len){if(furMats[len])return furMats[len];const m=new T.MeshStandardMaterial({vertexColors:true,roughness:1,alphaMap:noise()});
m.onBeforeCompile=sh=>{sh.uniforms.uFur={value:len};sh.uniforms.uTime=FUR_TIME;
sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float aShell;uniform float uFur;uniform float uTime;varying float vShell;')
.replace('#include <begin_vertex>','#include <begin_vertex>\nvShell=aShell;transformed+=objectNormal*uFur*aShell;transformed.y-=uFur*.3*aShell*aShell;transformed.x+=sin(uTime*1.7+position.y*9.+position.z*7.)*uFur*.08*aShell*aShell;');
sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nvarying float vShell;')
.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb*=mix(.8,1.,vShell);')
.replace('#include <alphatest_fragment>','if(diffuseColor.a<.15+.7*vShell)discard;')};
m.customProgramCacheKey=()=>'ade-fur';return furMats[len]=m}
function setShells(fm,n){const g=fm.geometry,a=g.attributes.aShell;for(let i=0;i<n;i++)a.array[i]=(i+1)/n;a.needsUpdate=true;g.instanceCount=n;fm.visible=n>0}
let scTex;function scaleTex(){if(scTex)return scTex;const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,128,128);
for(let r=0;r<8;r++)for(let q=0;q<9;q++){const x=q*16+(r%2?8:0),y=r*16,gr=g.createRadialGradient(x,y,1,x,y,10);gr.addColorStop(0,'#fff');gr.addColorStop(1,'#222');g.fillStyle=gr;g.beginPath();g.arc(x,y,9,0,7);g.fill()}
scTex=new T.CanvasTexture(c);scTex.wrapS=scTex.wrapT=T.RepeatWrapping;return scTex}
function organic(st,o={}){const den=o.den||4.5,L=loft(st,o.seg||16,den,o.sub,o.ck),g=new T.BufferGeometry();
g.setAttribute('position',new T.BufferAttribute(L.pos,3));g.setAttribute('uv',new T.BufferAttribute(L.uv,2));g.setIndex(new T.BufferAttribute(L.idx,1));g.computeVertexNormals();
const P=g.attributes.position,Nn=g.attributes.normal,U=g.attributes.uv,col=new Float32Array(P.count*3),c=new T.Color();
for(let i=0;i<P.count;i++){c.copy(o.cf?o.cf(P.getX(i),P.getY(i),P.getZ(i),Nn.getX(i),Nn.getY(i),Nn.getZ(i),U.getY(i)/den):C('#888888'));col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b}
g.setAttribute('color',new T.BufferAttribute(col,3));
const m=new T.Mesh(g,new T.MeshPhysicalMaterial({vertexColors:true,roughness:o.rough??.9,sheen:o.fur?.6:0,sheenColor:C('#ffffff'),sheenRoughness:.7,clearcoat:o.cc||0,clearcoatRoughness:.35,bumpMap:o.bump||null,bumpScale:o.bs||1}));
m.castShadow=m.receiveShadow=true;
if(o.fur){m.userData.furLen=o.fur;const N=o.N||8,fg=new T.InstancedBufferGeometry();fg.index=g.index;for(const k in g.attributes)fg.setAttribute(k,g.attributes[k]);
fg.setAttribute('aShell',new T.InstancedBufferAttribute(new Float32Array(N),1));const fm=new T.Mesh(fg,furMat(o.fur));fm.userData.shell=true;fm.userData.furN=N;fm.frustumCulled=false;setShells(fm,N);m.add(fm);if(FUR_REG)FUR_REG.push(fm)}
return m}
function qeye(r,iris,slit,liner){return grp(null,sph(liner||'#1a1410',{s:[r*1.1,r*1.1,r*.55],p:[0,0,r*.25],rg:.3}),sph(iris,{s:[r*.9,r*.9,r*.5],p:[0,0,r*.55],rg:.2}),
sph('#0b0b10',{s:slit?[r*.3,r*.8,r*.2]:[r*.5,r*.5,r*.2],p:[0,0,r*.9],rg:.12}),sph('#fff',{s:r*.22,p:[r*.32,r*.34,r*1.02],g:1}),sph('#fff',{s:r*.1,p:[-r*.3,-r*.3,r*1.02],g:1}))}

/* coats painted per vertex */
const catCoat=(tag,off=0)=>(x,y,z,nx,ny,nz,s)=>{const B=C('#f5a24b'),D=C('#d1651a'),W=C('#fcebd2');let c=B;
if(tag==='body'){const st=Math.sin(z*34+Math.sin(y*12+x*7)*1.4);c=MIXC(c,D,sm(.15,.45,st)*sm(-.3,.4,ny));c=MIXC(c,W,sm(-.1,-.5,ny));c=MIXC(c,W,sm(.1,.5,nz)*sm(.26,.4,z))}
else if(tag==='head'){const f=Math.abs(Math.cos(x*30));c=MIXC(c,D,sm(.55,.75,f)*sm(.04,.07,y)*sm(.13,.1,Math.abs(x))*sm(-.12,-.05,z)*.95);
 c=MIXC(c,D,sm(.75,.9,Math.sin(y*80))*sm(.11,.14,Math.abs(x))*sm(.06,.0,Math.abs(y+.01)));
 c=MIXC(c,D,sm(.04,.06,Math.abs(x)-.0)*(Math.abs(x)>.055&&Math.abs(x)<.1&&y>.055&&y<.075&&z>.09?1:0)*.9);
 c=MIXC(c,W,sm(.09,.14,z)*sm(.0,-.05,y)*.95);c=MIXC(c,W,sm(-.3,-.7,ny))}
else if(tag==='legU'||tag==='legL'){c=MIXC(c,D,sm(.2,.5,Math.sin((s+off)*62))*.9);if(tag==='legL')c=MIXC(c,W,sm(.145,.175,s+off))}
else if(tag==='paw')c=W;
else c=MIXC(MIXC(B,D,sm(.15,.45,Math.sin((s+off)*60))),W,sm(.36,.42,s+off));
return c};
const foxCoat=(tag,off=0)=>(x,y,z,nx,ny,nz,s)=>{const O=C('#d8651f'),K=C('#2a1d1f'),W=C('#f6ede0');let c=O;
if(tag==='body'){c=MIXC(c,C('#b44a16'),sm(.45,.95,ny)*.7);c=MIXC(c,W,sm(-.2,-.65,ny));c=MIXC(c,W,sm(.1,.5,nz)*sm(.34,.46,z))}
else if(tag==='head'){c=MIXC(c,W,sm(-.012,-.045,y)*sm(-.02,.05,z));c=MIXC(c,W,sm(.045,.075,Math.abs(x))*sm(.02,-.03,y)*.9);c=MIXC(c,C('#a94212'),sm(.4,1,ny)*.4)}
else if(tag==='legU')c=MIXC(O,K,sm(.1,.17,s+off)*.9);
else if(tag==='legL'||tag==='paw')c=K;
else c=MIXC(O,W,sm(.46,.56,s+off));
return c};
const pandaCoat=(tag,off=0)=>(x,y,z,nx,ny,nz,s)=>{const W=C('#f6f5f0'),K=C('#1b1b20');let c=W;
if(tag==='body')c=MIXC(W,K,sm(.26,.33,z)*sm(.52,.45,z));
else if(tag==='head'){const ex=Math.abs(x)-.078+(y-.025)*.6,e=(ex/.05)**2+((y-.025)/.062)**2+((z-.15)/.09)**2;c=MIXC(W,K,sm(1.25,.7,e)*(Math.abs(x)>.03?1:0))}
else if(tag==='tail')c=W;else c=K;
return c};
const dragCoat=(tag,off=0)=>(x,y,z,nx,ny,nz,s)=>{const G=C('#47a562'),GD=C('#276b46'),B=C('#efdca0');let c=MIXC(G,GD,sm(.15,.9,ny));
c=MIXC(c,C('#79c585'),.25*sm(.5,1,Math.sin(x*70+z*55)));c=MIXC(c,B,sm(-.1,-.55,ny)*(tag==='head'||tag==='body'?.92*(.88+.12*Math.sin(z*75)):.3));return c};

/* species */
const SP={
cat:{celeb:{hop:.45},amp:.5,S:2.9,Ls:.36,fore:[.08,.1],hind:[.09,.1,.4,.5],paw:.035,fx:.07,hx:.075,rf:[.06,.064,.05,.052,.043,.045],rh:[.07,.075,.05,.052,.038,.04],
spine:[[-.1,.075,.085,.05],[0,.115,.12,.06],[.12,.135,.14,.065],[.26,.135,.14,.07],[.36,.12,.125,.07],[.44,.1,.105,.1],[.48,.09,.095,.14]],
head:[[-.02,.19,.165,0],[.03,.19,.165,0]],tilt:.08,toes:true,
eye:{x:.082,y:-.01,z:.165,r:.052,iris:'#8fbf3f',slit:true,toe:.3},nose:{c:'#f27f93',s:[.02,.015,.012],p:[0,-.045,.205]},
blobs:[{x:.052,y:-.072,z:.14,rx:.065,ry:.05,zl:.012,c:'#fcebd2',fur:.012,mirror:true},{x:0,y:-.125,z:.09,rx:.07,ry:.045,zl:.02,c:'#fcebd2',fur:.012},{x:.165,y:-.055,z:-.02,rx:.03,ry:.036,zl:.05,c:'#f5a24b',fur:.014,mirror:true}],
mouth:{r:.016,x:.018,y:-.072,z:.198},
ears:[{x:.105,y:.105,z:-.01,w:.082,h:.15,tilt:.55,loft:true,root:true,c:'#f5a24b',ci:'#f48a9c',rc:'#f5a24b'}],whisk:{l:.17,y:-.07,z:.14},
tail:{n:6,len:.07,rad:[.055,.058,.06,.058,.054,.048,.038],a0:-1.8,da:.24,dy:.05,z:-.09},fur:[.016,.01,.012,.022],coat:catCoat,
sit:{th:1.1,dy:.08,k:1.66,h:-.3,kn:0,tu:1.2,curl:.9}},
fox:{celeb:{hop:.45},amp:.3,S:2.2,Ls:.46,fore:[.12,.14],hind:[.12,.14,.5,.6],paw:.03,fx:.06,hx:.062,rf:[.042,.05,.033,.035,.025,.027],rh:[.062,.072,.04,.042,.027,.029],
spine:[[-.08,.075,.085,.04],[.05,.09,.1,.045],[.2,.095,.105,.05],[.36,.095,.105,.055],[.46,.082,.09,.05],[.54,.066,.075,.08],[.6,.058,.065,.12]],
head:[[-.02,.092,.082,0],[.02,.092,.082,0]],hparts:[[[-.02,.092,.082,0],[.02,.092,.082,0]],[[.0,.068,.06,-.008],[.07,.052,.046,-.016],[.12,.034,.03,-.024],[.18,.02,.019,-.03]]],tilt:.1,
eye:{x:.052,y:.018,z:.075,r:.03,iris:'#d18a1c',slit:true,toe:.6},nose:{c:'#14100f',s:[.017,.014,.013],p:[0,-.034,.196]},
blobs:[{x:.078,y:-.03,z:-.015,rx:.026,ry:.034,zl:.045,c:'#f6ede0',fur:.02,mirror:true}],mouth:{r:.012,x:.012,y:-.052,z:.17},
ears:[{x:.046,y:.046,z:-.012,w:.054,h:.15,tilt:.22,loft:true,root:true,rc:'#d8651f',c:'#241a1c',ci:'#f1e2cc'}],whisk:null,
tail:{n:7,len:.1,rad:[.03,.05,.065,.07,.065,.05,.03,.012],a0:-1.75,da:.06,dy:.03,z:-.06},fur:[.03,.014,.014,.05],coat:foxCoat},
panda:{celeb:{hop:.3},amp:.55,S:2.2,Ls:.44,fore:[.12,.14],hind:[.13,.14,.35,.4],paw:.04,fx:.095,hx:.095,rf:[.075,.085,.06,.063,.05,.052],rh:[.085,.095,.065,.068,.052,.055],
spine:[[-.1,.12,.13,.06],[.04,.16,.17,.07],[.2,.17,.18,.075],[.34,.165,.175,.08],[.44,.14,.15,.08],[.5,.11,.12,.1],[.54,.1,.11,.13]],
head:[[-.02,.17,.15,0],[.03,.17,.15,0]],tilt:.08,
eye:{x:.078,y:.03,z:.142,r:.036,iris:'#5a3a24',slit:false,toe:.3,liner:'#050506'},nose:{c:'#101012',s:[.034,.024,.022],p:[0,-.03,.178]},
blobs:[{x:0,y:-.055,z:.13,rx:.075,ry:.055,zl:.02,c:'#f6f5f0',fur:.02},{x:.14,y:-.04,z:.02,rx:.04,ry:.05,zl:.06,c:'#f6f5f0',fur:.025,mirror:true}],
mouth:{r:.016,x:.018,y:-.058,z:.18},
ears:[{x:.125,y:.115,z:-.005,r:.06,round:true,tilt:.2,c:'#1b1b20',fur:.02}],whisk:null,
tail:{n:2,len:.05,rad:[.07,.065,.045],a0:-1.7,da:.2,dy:.06,z:-.1},fur:[.04,.03,.03,.03],coat:pandaCoat},
dragon:{celeb:{hop:.4},amp:.3,S:2.4,Ls:.36,fore:[.08,.1],hind:[.09,.1,.4,.5],paw:.035,fx:.07,hx:.075,rf:[.05,.055,.042,.044,.033,.035],rh:[.07,.075,.05,.052,.036,.038],
spine:[[-.1,.075,.085,.05],[0,.11,.115,.06],[.12,.125,.13,.065],[.26,.125,.13,.07],[.36,.11,.115,.07],[.44,.085,.09,.1],[.5,.07,.075,.15]],
head:[[-.02,.105,.095,0],[.03,.105,.095,0]],hparts:[[[-.02,.105,.095,0],[.03,.105,.095,0]],[[.03,.07,.058,-.025],[.09,.062,.05,-.03],[.14,.042,.034,-.03]]],tilt:.08,tuftC:'#efdca0',tufts:[{x:.1,y:-.01,z:-.01,r:.02,h:.08,rz:1.57,ry:.7},{x:.095,y:-.04,z:0,r:.016,h:.06,rz:1.9,ry:.6}],
eye:{x:.066,y:.03,z:.085,r:.036,iris:'#f0b92a',slit:true,toe:.5,liner:'#10261a'},nose:{c:'#efdca0',s:[.001,.001,.001],p:[0,0,0]},
blobs:[],mouth:null,ears:[],whisk:null,wing:.55,
tail:{n:9,len:.08,rad:[.065,.06,.056,.051,.046,.04,.034,.026,.018,.01],a0:-1.8,da:.09,dy:.06,z:-.09},fur:null,coat:dragCoat,rough:.5,cc:.3,dragon:true}};

function Quad(sp){
const FR=[];FUR_REG=FR;
const S=sp.S,[f1,f2]=sp.fore,[h1,h2,a1,a2]=sp.hind,pw=sp.paw,Ls=sp.Ls,fu=sp.fur||[0,0,0,0];
const Hf=f1+f2+pw,Hh=h1*Math.cos(a1)+h2*Math.cos(a2)+pw,hz=-(h1*Math.sin(a1)-h2*Math.sin(a2)),yl=z=>{const u=Math.max(0,Math.min(1,z/Ls));return Hh+(Hf-Hh)*u};
const pivot=new T.Group(),skin=new T.Group(),half=(Ls+hz)/2;pivot.add(skin);skin.scale.setScalar(S);pivot.position.z=-half*S;
const r={legs:{},tail:[],ears:[],pitch:pivot,skin,rest:{}},mo={rough:sp.rough,cc:sp.cc,bump:sp.dragon?scaleTex():null,bs:2},F=(n,N)=>fu[n]?{fur:fu[n],N}:{};
const spine=sp.spine.map(([z,rx,ry,dy])=>({p:[0,yl(z)+dy,hz+z],rx,ry}));
const torso=organic(spine,{cf:sp.coat('body'),seg:26,sub:3,...F(0,12),...mo});skin.add(torso);
const tg=[torso.geometry];tg.forEach(g=>{g.userData={o:g.attributes.position.array.slice(),n:g.attributes.normal.array.slice()}});
torso.frustumCulled=false;const atts=[];
const last=spine[spine.length-1],head=new T.Group();head.position.set(0,last.p[1],last.p[2]);head.rotation.x=sp.tilt;skin.add(head);r.head=head;atts.push({o:head,p:[0,last.p[1],last.p[2]]});
(sp.hparts||[sp.head]).forEach(st=>head.add(organic(st.map(([z,rx,ry,cy])=>({p:[0,cy,z],rx,ry})),{cf:sp.coat('head'),seg:40,sub:4,ck:8,...F(1,10),...mo})));
const E=sp.eye;r.eyes=[-1,1].map(sd=>{const e=qeye(E.r,E.iris,E.slit,E.liner);e.position.set(sd*E.x,E.y,E.z);e.rotation.y=sd*E.toe;head.add(e);return e});
const hl=sp.head[sp.head.length-1];head.add(sph(sp.nose.c,{s:sp.nose.s,p:sp.nose.p,rg:.25}));
(sp.blobs||[]).forEach(b=>(b.mirror?[-1,1]:[1]).forEach(sd=>{const m=organic([{p:[0,0,-b.zl/2],rx:b.rx,ry:b.ry},{p:[0,0,b.zl/2],rx:b.rx,ry:b.ry}],{cf:()=>C(b.c),fur:b.fur,N:6,seg:14});m.position.set(sd*b.x,b.y,b.z);head.add(m)}));
(sp.tufts||[]).forEach(t=>[-1,1].forEach(sd=>head.add(cone(t.r,t.h,t.c||sp.tuftC,{p:[sd*t.x,t.y,t.z],r:[0,sd*t.ry,-sd*t.rz],rg:.8}))));
if(sp.mouth){const m=sp.mouth;[-1,1].forEach(sd=>head.add(mesh(new T.TorusGeometry(m.r,.0035,6,12,Math.PI),'#5a3a30',{p:[sd*m.x,m.y,m.z],r:[0,0,Math.PI]})))}
if(sp.whisk){const w=sp.whisk,wg=new T.Group();for(const sd of[-1,1])for(let i=0;i<4;i++)wg.add(cyl(.0009,w.l,'#f4f1ea',{p:[sd*(.03+w.l*.47),w.y+(i-1.5)*.007,w.z],r:[0,0,Math.PI/2+sd*(-.12+(i-1.5)*.1)]}));bake(wg,wg.children.slice(),{rough:.6});head.add(wg)}
sp.ears.forEach(e=>[-1,1].forEach(sd=>{const g=new T.Group();g.position.set(sd*e.x,e.y,e.z);g.rotation.z=-sd*e.tilt;g.userData.base=-sd*e.tilt;
if(e.round)g.add(organic([{p:[0,0,-e.r*.5],rx:e.r,ry:e.r},{p:[0,0,e.r*.5],rx:e.r*.9,ry:e.r*.9}],{cf:()=>C(e.c),fur:e.fur,N:6,seg:12}));
else if(e.loft)g.add(organic([{p:[0,0,0],rx:e.w,ry:e.w*.36},{p:[0,e.h*.5,0],rx:e.w*.74,ry:e.w*.3},{p:[0,e.h,0],rx:e.w*.12,ry:e.w*.1}],{cf:(x,y,z,nx,ny,nz)=>{const wd=Math.max(e.w*(1-.88*Math.min(1,Math.max(0,y/e.h))),.001);return MIXC(C(e.c),C(e.ci),sm(.15,.55,nz)*sm(.01,.04,y)*sm(.7,.5,Math.abs(x)/wd)*sm(.92,.7,y/e.h))},seg:18,sub:3}));
else{g.add(cone(e.r,e.h,e.c,{p:[0,e.h/2,0],s:[1,1,.45],rg:.9}));g.add(cone(e.r*.7,e.h*.8,e.ci,{p:[0,e.h*.4,e.r*.18],s:[1,1,.4],rg:.9}))}
if(e.root)g.add(organic([{p:[0,0,-e.w*.15],rx:e.w*.8,ry:e.w*.55},{p:[0,0,e.w*.15],rx:e.w*.8,ry:e.w*.55}],{cf:()=>C(e.rc||e.c),fur:.012,N:5,seg:14}));
if(e.tuft)for(let i=-1;i<2;i++)g.add(cone(.01,.045,'#fff6e8',{p:[i*e.r*.28,e.h*.2,e.r*.3],r:[.3,0,-i*.25],rg:.8}));head.add(g);r.ears.push(g)}));
const mk=(side,front,key)=>{const L=front?sp.fore:[h1,h2],q=front?sp.rf:sp.rh,hip=new T.Group();hip.position.set(side*(front?sp.fx:sp.hx),front?Hf:Hh,front?hz+Ls:hz);
hip.add(organic([{p:[0,0,0],rx:q[0],ry:q[1]},{p:[0,-L[0],0],rx:q[2],ry:q[3]}],{cf:sp.coat('legU',0),seg:14,...F(2,6),...mo}));
const knee=new T.Group();knee.position.y=-L[0];hip.add(knee);
knee.add(organic([{p:[0,0,0],rx:q[2]*.92,ry:q[3]*.92},{p:[0,-L[1],0],rx:q[4],ry:q[5]}],{cf:sp.coat('legL',L[0]),seg:14,...F(2,6),...mo}));
const paw=new T.Group();paw.position.y=-L[1];knee.add(paw);
paw.add(organic([{p:[0,-pw*.5,-pw*.2],rx:q[4]*1.3,ry:pw*.5},{p:[0,-pw*.5,pw*.9],rx:q[4]*1.4,ry:pw*.5}],{cf:sp.coat('paw',0),seg:12,...F(2,5),...mo}));
{const tz=new T.Group();if(sp.toes)for(let i=-1;i<2;i++)tz.add(sph('#fcebd2',{s:.011,p:[i*q[4]*.85,-pw*.5,pw*.95],rg:.8}));
if(sp.dragon)for(let i=-1;i<2;i++)tz.add(cone(.008,.03,'#e6d7a3',{p:[i*q[4]*.9,-pw*.6,pw*1.05+.01],r:[Math.PI/2,0,0]}));if(tz.children.length){bake(tz,tz.children.slice(),{rough:.8});paw.add(tz)}}
skin.add(hip);atts.push({o:hip,p:[hip.position.x,hip.position.y,hip.position.z]});const rest=front?[0,0]:[-a1,a1+a2];hip.rotation.x=rest[0];knee.rotation.x=rest[1];paw.rotation.x=-(rest[0]+rest[1]);
r.legs[key]={hip,knee,paw};r.rest[key]=rest};
mk(-1,true,'fl');mk(1,true,'fr');mk(-1,false,'bl');mk(1,false,'br');
const tc=sp.tail;let par=new T.Group();par.position.set(0,yl(0)+tc.dy,hz+tc.z);skin.add(par);atts.push({o:par,p:[0,yl(0)+tc.dy,hz+tc.z],follow:true,r0:0});
for(let i=0;i<tc.n;i++){const seg=new T.Group();if(i)seg.position.y=tc.len;par.add(seg);
seg.add(organic([{p:[0,0,0],rx:tc.rad[i],ry:tc.rad[i]},{p:[0,tc.len,0],rx:tc.rad[i+1],ry:tc.rad[i+1]}],{cf:sp.coat('tail',i*tc.len),seg:12,...F(3,6),...mo}));
if(sp.dragon)seg.add(cone(.014*(1-i*.08),.05,'#e6d7a3',{p:[0,tc.len/2,tc.rad[i]*.9],r:[Math.PI/2,0,0]}));
seg.rotation.x=i?tc.da:tc.a0;r.tail.push(seg);par=seg}
let upd=null,tc0;
if(sp.dragon){const wings=[],G='#2a6a48',K=sp.wing;
spine.forEach((s,i)=>{if(i){skin.add(cone(.016,.055,'#efdca0',{p:[0,s.p[1]+s.ry*.95+.02,s.p[2]],r:[-.5,0,0]}));const cn=skin.children[skin.children.length-1];atts.push({o:cn,p:[0,s.p[1]+s.ry*.95+.02,s.p[2]],follow:true,r0:-.5})}});
tc0=r.tail[r.tail.length-1];tc0.add(cone(.055,.12,'#2a6a48',{p:[0,.1,0],s:[1,1,.3],rg:.5}));
[-1,1].forEach(sd=>{head.add(cone(.03,.2,'#efdca0',{p:[sd*.055,.078,-.01],r:[-1.15,0,-sd*.35],rg:.4}));head.add(sph('#2f6b4a',{s:[.032,.014,.04],p:[sd*.06,.088,.06],r:[0,0,-sd*.25],rg:.5}));
 head.add(sph('#3a8a58',{s:.015,p:[sd*.02,-.008,.152],rg:.5}));head.add(sph('#0b140f',{s:.006,p:[sd*.02,-.008,.164]}));head.add(cyl(.0025,.1,'#10261a',{p:[sd*.05,-.05,.1],r:[Math.PI/2,0,sd*.08]}))});
const P0={E:[.2,.2,-.08],W:[.4,.36,-.18],F1:[.68,.3,-.34],F2:[.74,.08,-.5],F3:[.56,-.12,-.52],B:[.02,-.06,-.34],O:[0,0,0]},pts={};for(const k in P0)pts[k]=P0[k].map(v=>v*K);
const bone=(a,b,r0,r1)=>organic([{p:a,rx:r0,ry:r0},{p:b,rx:r1,ry:r1}],{cf:()=>C(G),seg:8});
const ar=[];[['E','W','F1'],['E','F1','F2'],['E','F2','F3'],['E','F3','B'],['O','E','B']].forEach(t=>t.forEach(k=>ar.push(...pts[k])));
const mg=new T.BufferGeometry();mg.setAttribute('position',new T.Float32BufferAttribute(ar,3));mg.computeVertexNormals();
[-1,1].forEach(sd=>{const g=new T.Group();g.position.set(sd*.07,yl(Ls*.7)+.1,hz+Ls*.7);g.scale.x=sd;const w=new T.Group();g.add(w);
{const bz=new T.Group();bz.add(bone(pts.O,pts.E,.016,.012),bone(pts.E,pts.W,.012,.009),bone(pts.W,pts.F1,.008,.003),bone(pts.W,pts.F2,.008,.003),bone(pts.W,pts.F3,.008,.003));bake(bz,bz.children.slice(),{rough:.7});w.add(bz)}
w.add(new T.Mesh(mg,new T.MeshPhysicalMaterial({color:'#e0924a',roughness:.55,side:T.DoubleSide,transparent:true,opacity:.92,clearcoat:.2})));skin.add(g);wings.push(w);atts.push({o:g,p:[sd*.07,yl(Ls*.7)+.1,hz+Ls*.7],follow:true,r0:0})});
const ft=(()=>{const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d'),gr=g.createRadialGradient(32,32,0,32,32,32);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(.4,'rgba(255,255,255,.55)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,64,64);return new T.CanvasTexture(c)})();
const fire=[],fg=new T.Group();fg.position.set(0,-.03,.18);head.add(fg);let fa=0;
for(let i=0;i<16;i++){const m=new T.Sprite(new T.SpriteMaterial({map:ft,color:0xffcc55,transparent:true,depthWrite:false,blending:T.AdditiveBlending,opacity:0}));m.visible=false;fg.add(m);fire.push(m)}
upd=(t,s)=>{const f=s==='celebrating'?12:s==='strolling'?7:2.2,a=s==='celebrating'?.5:s==='strolling'?.28:.1,sl=s==='sleeping';wings.forEach(w=>{w.rotation.z+=((sl?-.05:.55+Math.sin(t*f)*a)-w.rotation.z)*.15;w.rotation.y+=((sl?-1.15:-.35)-w.rotation.y)*.15});fa+=((s==='celebrating'?1:0)-fa)*.12;fire.forEach((m,i)=>{const L=(t*1.7+i/16)%1,on=fa>.02;m.visible=on;if(!on)return;m.position.set(Math.sin(t*9+i*2.1)*.015*L,.02+L*.12+Math.sin(t*7+i)*.01,.02+L*.5);m.scale.setScalar((.05+L*.2)*fa);m.material.opacity=Math.pow(1-L,1.4)*.85*fa;m.material.color.setRGB(1,1-.55*L,.4-.35*L)})}}
const zA=spine[0].p[2],zB=spine[spine.length-1].p[2],yR=spine[2].p[1],NB=40;let lastA=0;r.A=0;r.aF=0;r.aR=0;r.aH=0;
const TO=[0,0,0];
const table=A=>{const al=new Float32Array(NB+1),zc=new Float32Array(NB+1),yc=new Float32Array(NB+1),dz=(zB-zA)/NB;for(let i=0;i<=NB;i++){const u=i/NB;al[i]=A*(2*u*u*(3-2*u)-1)}
for(let i=1;i<=NB;i++){const a=(al[i]+al[i-1])/2;zc[i]=zc[i-1]+Math.cos(a)*dz;yc[i]=yc[i-1]-Math.sin(a)*dz}return{al,zc,yc}};
const tf=(Tb,y,z)=>{const u=(z-zA)/(zB-zA);let a,Z,Y;if(u<=0){a=Tb.al[0];const d=z-zA;Z=d*Math.cos(a);Y=-d*Math.sin(a)}
else if(u>=1){a=Tb.al[NB];const d=z-zB;Z=Tb.zc[NB]+d*Math.cos(a);Y=Tb.yc[NB]-d*Math.sin(a)}
else{const f=u*NB,i=Math.floor(f),w=f-i;a=Tb.al[i]*(1-w)+Tb.al[i+1]*w;Z=Tb.zc[i]*(1-w)+Tb.zc[i+1]*w;Y=Tb.yc[i]*(1-w)+Tb.yc[i+1]*w}
const yr=y-yR;TO[0]=yR+Y+yr*Math.cos(a);TO[1]=zA+Z+yr*Math.sin(a);TO[2]=a;return TO};
r.bend=A=>{if(Math.abs(A-lastA)<.002)return;lastA=A;const Tb=table(A);
tg.forEach(g=>{const P=g.attributes.position.array,N=g.attributes.normal.array,o=g.userData.o,n0=g.userData.n;for(let i=0;i<P.length;i+=3){const q=tf(Tb,o[i+1],o[i+2]),c=Math.cos(q[2]),s=Math.sin(q[2]);P[i]=o[i];P[i+1]=q[0];P[i+2]=q[1];N[i]=n0[i];N[i+1]=n0[i+1]*c-n0[i+2]*s;N[i+2]=n0[i+1]*s+n0[i+2]*c}g.attributes.position.needsUpdate=true;g.attributes.normal.needsUpdate=true});
atts.forEach(a=>{const q=tf(Tb,a.p[1],a.p[2]);a.o.position.set(a.p[0],q[0],q[1]);if(a.follow)a.o.rotation.x=a.r0+q[2]});
r.aH=tf(Tb,0,zB)[2];r.aF=tf(Tb,0,hz+Ls)[2];r.aR=tf(Tb,0,hz)[2]};
r.bobKids=[pivot];
const lie=Math.min(...spine.map(s=>s.p[1]-s.ry)),fa=Math.acos(Math.max(0,Math.min(1,(Hf-lie)/(f1+f2+pw))));
FUR_REG=null;
return {r,quad:true,sp,lie,fa,fur:FR,size:S,sw:S*.4,sl:S*(Ls+hz)*1.45,desk:[.06,S*(half+.12)],update:upd}}

function animateQ(p,t,dt){const {r,cfg}=p,sp=cfg.sp,s=p.state,d=(a,b,k=10)=>T.MathUtils.damp(a,b,k,dt),cl=(v,a)=>Math.max(-a,Math.min(a,v));
if(p._prev==='celebrating'&&p.state!=='celebrating'){const a=r.walker.rotation.y;r.walker.rotation.y=Math.atan2(Math.sin(a),Math.cos(a))}
let x=0,yaw=.65,y=0,pitch=0,hx=0,hy=0,eye=1,tw=.22,tf=1.2,tu=0,curl=0,br=.012,bf=1.9,stretch=1,pk=1,sprd=0,sq=1,Atg=0;
const G4={};for(const k in r.rest)G4[k]=r.rest[k].slice();const add=(k,h,n)=>{G4[k][0]+=h;G4[k][1]+=n};
if(s==='idle'&&sp.sit){const q=sp.sit;pitch=-q.th;y=-q.dy*sp.S;stretch=q.k;G4.fl=[q.th,0];G4.fr=[q.th,0];G4.bl=[q.h,q.kn];G4.br=[q.h,q.kn];yaw=.55+Math.sin(t*.3)*.06;hy=cl(-yaw+p.look.x*.6,.9);hx=q.th-.25+p.look.y*.3;tu=q.tu;curl=q.curl;tw=.12;Atg=.25}
else if(s==='idle'){yaw=.65+Math.sin(t*.3)*.08;hy=cl(-yaw+p.look.x*.6,.9);hx=p.look.y*.35+Math.sin(t*.8)*.03}
else if(s==='strolling'){const ph=t*8.5,w=(k,fr,o)=>add(k,-(fr?.5:.42)*Math.sin(ph+o),(fr?.9:.8)*Math.max(0,Math.cos(ph+o)));
Atg=.1*Math.sin(t*8.5*2);x=Math.sin(t*.5)*sp.amp;yaw=p.facing?(p.facing>0?Math.PI/2:-Math.PI/2):(Math.cos(t*.5)>0?Math.PI/2:-Math.PI/2);y=Math.abs(Math.sin(ph))*.02;w('fl',1,0);w('br',0,0);w('fr',1,Math.PI);w('bl',0,Math.PI);hx=Math.sin(ph*2)*.03;tw=.18;tf=4;br=0}
else if(s==='celebrating'){const q=sp.celeb,ph=t*7,Hs=Math.pow(Math.sin(ph/2),2),V=Math.sin(ph),cr=(1-Hs)*(1-Hs);if(p._prev!=='celebrating')p.cT=t;
Atg=.5*cr+.2*Hs-.4*Math.pow(Math.max(0,V),2);y=Hs*q.hop;pitch=-.28*V;yaw=(t-p.cT)*2.4;hy=0;hx=-.18+.2*V;sq=1+.08*Hs-.1*cr;
add('fl',-.8*Hs,.2*Hs+.5*cr);add('fr',-.8*Hs,.2*Hs+.5*cr);add('bl',.6*Hs,-.5*Hs+.4*cr);add('br',.6*Hs,-.5*Hs+.4*cr);tw=.6;tf=14;tu=1;br=0}
else if(s==='working'){yaw=.5;pitch=.04;hx=.5;add('fl',-.55+Math.sin(t*19)*.06,.5);add('fr',-.55+Math.sin(t*23+1)*.06,.5);eye=.8;tw=.12;tf=1}
else{y=-(cfg.lie-.004)*sp.S;yaw=.8;hx=.3;hy=cl(-yaw*.45,.9);eye=.08;br=.03;bf=1.3;curl=1.4;tu=-.3;tw=0;Atg=.3;G4.fl=[-cfg.fa,0];G4.fr=[-cfg.fa,0];G4.bl=[-1.45,2.7];G4.br=[-1.45,2.7]}
r.A=d(r.A,Atg,8);r.bend(r.A);
for(const k in G4){const L=r.legs[k],g=G4[k];L.hip.rotation.x=d(L.hip.rotation.x,g[0]-((k==='fl'||k==='fr')?r.aF:r.aR),14);L.knee.rotation.x=d(L.knee.rotation.x,g[1],14);L.hip.scale.y=d(L.hip.scale.y,(k==='fl'||k==='fr')?stretch:1,6);L.hip.rotation.z=d(L.hip.rotation.z,(k==='fl'?-1:k==='fr'?1:0)*sprd,10);L.paw.scale.y=1/L.hip.scale.y;L.paw.rotation.x=d(L.paw.rotation.x,(-(g[0]+g[1])-r.pitch.rotation.x)*((k==='fl'||k==='fr')?pk:1),14)}
const w=r.walker;w.position.x=d(w.position.x,x,6);w.rotation.y=d(w.rotation.y,yaw,s==='strolling'?5:3);
r.bob.position.y=d(r.bob.position.y,y,10);r.pitch.rotation.x=d(r.pitch.rotation.x,pitch,6);r.skin.scale.y=d(r.skin.scale.y,sp.S*(1+Math.sin(t*bf)*br)*sq,10);
r.head.rotation.x=d(r.head.rotation.x,sp.tilt+hx-.7*r.aH,8);r.head.rotation.y=d(r.head.rotation.y,hy,6);
const ph2=t%4.2,bl=ph2>4?1-.92*Math.sin((ph2-4)/.2*Math.PI):1,ev=s==='sleeping'?.08:eye*bl;r.eyes.forEach(e=>e.scale.y=d(e.scale.y,ev,30));
r.ears.forEach((e,i)=>{const tw2=Math.pow(Math.max(0,Math.sin(t*1.3+i*2.1)),14)*.3;e.rotation.z=e.userData.base+(i%2?-1:1)*tw2});
const tc=sp.tail;r.tail.forEach((g,i)=>{g.rotation.x=d(g.rotation.x,(i?tc.da+tu*.15:tc.a0+tu*.5),6);g.rotation.z=d(g.rotation.z,Math.sin(t*tf-i*.7)*tw*.5+curl*.35,6)});
const k=1-Math.min(r.bob.position.y/(sp.S*.8),1)*.3;p.sh.scale.set(cfg.sw*k,cfg.sl*k,1);
p.ws.root.rotation.y=w.rotation.y;p.ws.root.position.x=w.position.x;p.ws.update(s==='working',t,dt);p.cf.update(s==='celebrating',t);
p._prev=s;if(cfg.update)cfg.update(t,s)}



/* ---- sleeping Zzz ---- */
function makeZ(){const g=new T.Group(),sp=[],c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.font='bold 50px system-ui,sans-serif';x.textAlign='center';x.textBaseline='middle';x.lineWidth=6;x.strokeStyle='#5b6cff';x.fillStyle='#e8efff';x.strokeText('Z',32,35);x.fillText('Z',32,35);
const tex=new T.CanvasTexture(c);for(let i=0;i<3;i++){const m=new T.Sprite(new T.SpriteMaterial({map:tex,transparent:true,depthWrite:false,opacity:0}));m.visible=false;g.add(m);sp.push(m)}
return {g,update(on,t,base){sp.forEach((m,i)=>{m.visible=on;if(!on)return;const ph=(t*.3+i/3)%1;m.position.set(.8+ph*.7+Math.sin(t*2+i)*.06,base+ph*1.1,.3);m.scale.setScalar(.22+ph*.38);m.material.opacity=Math.sin(ph*Math.PI)*.95})}}}

/* ---- extras ---- */
function workstation(y,z){const root=grp(),bars=[];root.scale.setScalar(1e-4);root.visible=false;
const kb=grp([0,y,z],rbox(1,.07,.4,.04,'#1d2438',{r:.5}),box(.88,.02,.28,C2,{p:[0,.04,0],g:.5}));kb.rotation.x=-.1;
const hol=grp([1.35,2.1,.2],box(1.06,.84,.01,C2,{p:[0,0,-.02],g:.9}),box(1,.78,.02,'#0d1b2e',{o:.85}));hol.rotation.y=-.45;
for(let i=0;i<4;i++){const b=box(.7,.06,.01,C2,{p:[0,.25-i*.16,.02],g:1});bars.push(b);hol.add(b)}
const light=new T.PointLight(C2,0,4,2);light.position.set(0,1.5,1);root.add(kb,hol,light);
return {root,update(show,t,dt){const s=T.MathUtils.damp(root.scale.x,show?1:0,8,dt);root.scale.setScalar(Math.max(s,1e-4));root.visible=s>.02;light.intensity=3*s;
bars.forEach((b,i)=>{const w=.2+.8*Math.abs(Math.sin(t*1.1+i*1.9));b.scale.x=w;b.position.x=-.35+.35*w})}}}
const C2='#5df0ff';
function confetti(){const N=28,im=new T.InstancedMesh(new T.BoxGeometry(.1,.16,.02),new T.MeshStandardMaterial({roughness:.5}),N),d=new T.Object3D(),
cols=['#ff6b9d','#ffd166','#4cc9f0','#80ed99','#c77dff'],data=[];
for(let i=0;i<N;i++){data.push({x:(Math.random()-.5)*3.4,z:(Math.random()-.5)*1.6,o:Math.random()*3,sp:.9+Math.random()*.8,rs:(Math.random()+.5)*6});im.setColorAt(i,new T.Color(cols[i%5]))}
im.frustumCulled=false;im.visible=false;
return {im,update(on,t){im.visible=on;if(!on)return;data.forEach((p,i)=>{const f=(t*p.sp+p.o)%3;d.position.set(p.x+Math.sin(t*2+i)*.15,3.5-f*1.3,p.z);d.rotation.set(t*p.rs,t*p.rs*.7,0);d.updateMatrix();im.setMatrixAt(i,d.matrix)});im.instanceMatrix.needsUpdate=true}}}


function animate(p,t,dt){const {r,cfg}=p,s=p.state,d=(a,b,k=10)=>T.MathUtils.damp(a,b,k,dt),rot=(o,ax,v,k=12)=>{if(o)o.rotation[ax]=d(o.rotation[ax],v,k)};
if(p._prev==='celebrating'&&p.state!=='celebrating'){const a=r.walker.rotation.y;r.walker.rotation.y=Math.atan2(Math.sin(a),Math.cos(a))}
let x=0,yaw=0,y=0,sy=1,hx=0,hy=0,hz=0,az=0,tail=Math.sin(t*2)*.3,fl=0,fr=0,bl=0,br=0,eye=1,br_=1+Math.sin(t*2)*.015;
if(s==='idle'){hy=p.look.x*.8+Math.sin(t*.6)*.1;hx=p.look.y*.4+Math.sin(t*.9)*.05;fl=Math.sin(t*1.5)*.05;fr=-fl}
else if(s==='strolling'){const ph=t*9,sn=Math.sin(ph);x=Math.sin(t*.7)*1.2;yaw=p.facing?(p.facing>0?Math.PI/2:-Math.PI/2):(Math.cos(t*.7)>0?Math.PI/2:-Math.PI/2);y=Math.abs(sn)*.07;
fl=br=sn*cfg.swing;fr=bl=-sn*cfg.swing;hx=.08;tail=Math.sin(ph/2)*.5;br_=1}
else if(s==='celebrating'){const h=Math.pow(Math.sin(t*3.5),2);if(p._prev!=='celebrating')p.cT=t;y=h*.8;sy=1-.12*(1-h)*(1-h)+.06*h;br_=1;yaw=(t-p.cT)*4.5;fl=-3.1+Math.sin(t*14)*.35;fr=-3.1+Math.sin(t*14+Math.PI)*.35;bl=-.5*h;br=-.5*h;hx=-.25;tail=Math.sin(t*14)*.7;az=.6}
else if(s==='working'){fl=cfg.reach+Math.sin(t*19)*.1;fr=cfg.reach+Math.sin(t*23+1)*.1;hx=.32+Math.sin(t*.8)*.03;tail=Math.sin(t*1.2)*.25;eye=.85}
else{y=-(({axolotl:.24,robot:.36})[p.name]||.25);hx=.25;hz=.3;fl=fr=-.35;bl=br=-1.45;tail=Math.sin(t*.8)*.1;br_=1+Math.sin(t*1.4)*.035}
const ph=t%3.8,bl2=ph>3.6?1-.92*Math.sin((ph-3.6)/.2*Math.PI):1;eye=s==='sleeping'?.08:eye*bl2;
const w=r.walker;w.position.x=d(w.position.x,x,6);w.rotation.y=d(w.rotation.y,yaw,7);
const b=r.bob;b.position.y=d(b.position.y,y,20);b.scale.y=d(b.scale.y,sy*br_,14);b.scale.x=b.scale.z=1/Math.sqrt(b.scale.y);
const k=1-Math.min(b.position.y,1)*.35;p.sh.scale.setScalar(cfg.size*k);
rot(r.head,'x',hx);rot(r.head,'y',hy,6);rot(r.head,'z',hz,6);rot(r.fl,'z',(r.fl.userData.sz||0)-az,10);rot(r.fr,'z',(r.fr.userData.sz||0)+az,10);rot(r.tail,'y',tail,8);rot(r.fl,'x',fl,14);rot(r.fr,'x',fr,14);rot(r.bl,'x',bl,14);rot(r.br,'x',br,14);
[r.eyeL,r.eyeR].forEach(e=>e.scale.y=d(e.scale.y,eye,30));
if(r.gills){const f=s==='celebrating'?9:s==='working'?3:2.2;r.gills.forEach((g,i)=>g.rotation.z=g.userData.base+Math.sin(t*f+i*.9)*.12)}
if(r.bulb){const f=s==='working'?6:s==='celebrating'?12:1.6;r.bulb.material.emissiveIntensity=s==='sleeping'?.2+.15*Math.abs(Math.sin(t*1.2)):.8+.9*Math.abs(Math.sin(t*f))}
p._prev=s;cfg.update&&cfg.update(t,s);p.ws.update(s==='working',t,dt);p.cf.update(s==='celebrating',t)}
/* free GPU memory for one pet (shared fur materials / textures are released by the stage) */
function disposePet(root){root.traverse(o=>{if(o.geometry&&o.geometry.dispose)o.geometry.dispose();const m=o.material;if(m&&!o.userData.shell&&m.dispose){m.dispose()}})}

/* Can this pet's host element be seen? The canvas is FIXED over the whole app
   (z-index 38), so unlike the host it is not clipped by any ancestor — a host
   the app has hidden (the shell marks hidden rails/sidebars with aria-hidden,
   and a collapsed rail flips visibility) would otherwise keep painting its pet
   over the live view. Respect both markers before drawing. */
function hostShown(el){
 if(el.closest&&el.closest('[aria-hidden="true"]'))return false;
 const cv=el.checkVisibility;
 if(cv&&!cv.call(el,{visibilityProperty:true}))return false;
 return true;
}

/* ================= PetStage: one WebGL renderer, many pets, frugal by default ================= */
const QUALITY=[
 {pr:1,   shadow:0,    fur:.3, fps:24},   // 0 low    – no real shadows, thin fur, 24 fps
 {pr:1.25,shadow:512,  fur:.6, fps:30},   // 1 medium
 {pr:2,   shadow:1024, fur:1,  fps:30}];  // 2 high
/* Lighting presets, index-aligned with QUALITY. `key`/`rim`/`amb` are light
   intensities; `env` is the environment-map intensity every PBR material gets.
   Level 1 mirrors the stage's original hard-coded look, so a default `auto`
   stage (which starts at level 1) is unchanged. */
const LIGHTING=[
 {key:1.7,rim:0,   amb:.35,env:.3},   // 0 low    – key light only, flat and cheap
 {key:2.3,rim:1.5, amb:.1, env:1},    // 1 medium – key + rim + full environment
 {key:2.7,rim:1.9, amb:.06,env:1.5}]; // 2 high   – stronger key/rim, richer environment
const KINDS={cat:()=>Quad(SP.cat),fox:()=>Quad(SP.fox),panda:()=>Quad(SP.panda),dragon:()=>Quad(SP.dragon),axolotl:Axolotl2,robot:Robot};
const clamp1=v=>Math.max(-1,Math.min(1,v));
class PetStage{
 /**
  * opts: canvas?, quality:'auto'|'low'|'medium'|'high' (default 'auto'), fps (cap, default 30), maxPixelRatio (default 2)
  * The stage draws every pet into the rectangle of its `element` (scissor viewports), so one canvas / one GL context
  * serves any number of pets. It renders nothing while the page is hidden or while a pet's element is off screen.
  */
 constructor(opts={}){
  this.opt={quality:'auto',fps:30,maxPixelRatio:2,lighting:'auto',lightingIntensity:1,...opts};
  const canvas=this.canvas=opts.canvas||document.createElement('canvas');this._ownCanvas=!opts.canvas;
  const rd=this.renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:'low-power'});
  rd.shadowMap.enabled=true;rd.shadowMap.type=T.PCFSoftShadowMap;rd.toneMapping=T.ACESFilmicToneMapping;rd.toneMappingExposure=1.1;rd.info.autoReset=false;
  rd.debug.onShaderError=()=>{console.warn('[ade-pets] shader error: fur disabled');this._noFur=true;this.pets.forEach(p=>this._applyFur(p))};
  const scene=this.scene=new T.Scene();scene.environment=makeEnv(rd);this._env=scene.environment;
  this.ground=new T.Mesh(new T.CircleGeometry(4,48),new T.ShadowMaterial({opacity:.3}));this.ground.rotation.x=-Math.PI/2;this.ground.receiveShadow=true;scene.add(this.ground);
  const key=this.key=new T.DirectionalLight(0xfff4e6,2.3);key.position.set(3,6,5);key.shadow.mapSize.set(1024,1024);const sc=key.shadow.camera;sc.left=-4;sc.right=4;sc.top=4;sc.bottom=-4;sc.near=1;sc.far=20;key.shadow.bias=-.0004;key.shadow.normalBias=.02;
  const rim=this.rim=new T.DirectionalLight(0x9fd8ff,1.5);rim.position.set(-4,3,-4);const amb=this.amb=new T.AmbientLight(0xffffff,.1);scene.add(amb,key,rim);
  this.cam=new T.PerspectiveCamera(32,1,.1,100);
  this.pets=[];this._gaps=[];this._last=0;this._raf=0;this._px=-1e4;this._py=-1e4;this._noFur=false;
  this.stats={fps:0,calls:0,tris:0,level:1};
  this._auto=this.opt.quality==='auto';this.level=this._auto?1:({low:0,medium:1,high:2}[this.opt.quality]??1);
  this._lighting=this.opt.lighting||'auto';this._lightingIntensity=this.opt.lightingIntensity>0?this.opt.lightingIntensity:1;
  this._tick=this._tick.bind(this);
  this._onPointer=e=>{this._px=e.clientX;this._py=e.clientY};addEventListener('pointermove',this._onPointer,{passive:true});
  this._onVis=()=>{this._last=0};document.addEventListener('visibilitychange',this._onVis);
  if(typeof ResizeObserver!=='undefined'){this._ro=new ResizeObserver(()=>this._resize());this._ro.observe(canvas)}
  this._applyQuality();
 }
 /** add a pet ('cat'|'fox'|'panda'|'dragon'|'axolotl'|'robot') drawn into `element` (defaults to the whole canvas) */
 add(kind,o={}){
  const B=KINDS[kind];if(!B)throw new Error('[ade-pets] unknown pet: '+kind);
  const cfg=B(),r=cfg.r,holder=new T.Group(),walker=new T.Group(),bob=new T.Group(),sh=shadowMesh();
  sh.scale.setScalar(cfg.size);bob.add(...r.bobKids);walker.add(sh,bob);r.walker=walker;r.bob=bob;
  const ws=workstation(...cfg.desk),cf=confetti(),zz=makeZ();holder.add(walker,ws.root,cf.im,zz.g);realism(bob);holder.visible=false;this.scene.add(holder);
  const p={name:kind,kind,cfg,r,holder,ws,cf,sh,zz,state:o.state||'idle',look:{x:0,y:0},element:o.element||this.canvas,visible:true,
   setState:s=>{p.state=s},setFacing:f=>{p.facing=f},remove:()=>this.remove(p)};
  this.pets.push(p);this._applyFur(p);this._applyLighting();return p}
 remove(p){const i=this.pets.indexOf(p);if(i<0)return;this.pets.splice(i,1);this.scene.remove(p.holder);disposePet(p.holder)}
 setQuality(q){if(q==='auto'){this._auto=true}else{this._auto=false;this.level=typeof q==='number'?q:({low:0,medium:1,high:2}[q]??1)}this._applyQuality()}
 /** Set the lighting preset ('auto'|'low'|'medium'|'high') and overall brightness
     multiplier (slider). `auto` tracks the render-quality level. */
 setLighting(mode,intensity){this._lighting=mode||'auto';if(typeof intensity==='number'&&intensity>0)this._lightingIntensity=intensity;this._applyLighting()}
 start(){if(!this._raf){this._last=0;this._raf=requestAnimationFrame(this._tick)}}
 stop(){if(this._raf){cancelAnimationFrame(this._raf);this._raf=0}}
 /* Wipe the canvas. stop() halts the loop but leaves the last frame on this
    fixed, full-app canvas — callers clearing the scene must call this too, or
    the retired pets stay painted over whatever is shown next. */
 clear(){const rd=this.renderer;rd.setScissorTest(false);rd.clear()}
 /* Tear the stage down. `shared` frees the module-level fur materials +
    noise/scale textures — pass false for a SECONDARY stage (the Settings live
    preview) so it doesn't dispose resources the app-wide stage still uses. */
 dispose(shared=true){this.stop();removeEventListener('pointermove',this._onPointer);document.removeEventListener('visibilitychange',this._onVis);this._ro&&this._ro.disconnect();
  this.pets.slice().forEach(p=>this.remove(p));if(shared){for(const k in furMats)furMats[k].dispose();if(noiseTex)noiseTex.dispose();if(scTex)scTex.dispose();}
  this.ground.geometry.dispose();this.ground.material.dispose();this._env&&this._env.dispose&&this._env.dispose();this.renderer.dispose();this.renderer.forceContextLoss&&this.renderer.forceContextLoss();
  if(this._ownCanvas&&this.canvas.parentNode)this.canvas.parentNode.removeChild(this.canvas)}
 _resize(){const w=this.canvas.clientWidth||1,h=this.canvas.clientHeight||1;this.renderer.setSize(w,h,false)}
 _applyFur(p){const q=QUALITY[this.level];(p.cfg.fur||[]).forEach(fm=>setShells(fm,this._noFur||!q.fur?0:Math.max(2,Math.round(fm.userData.furN*q.fur))))}
 _applyQuality(){const q=QUALITY[this.level],rd=this.renderer,L=this.key;
  rd.setPixelRatio(Math.min((typeof devicePixelRatio!=='undefined'?devicePixelRatio:1),q.pr,this.opt.maxPixelRatio));this._resize();
  L.castShadow=q.shadow>0;if(q.shadow&&L.shadow.mapSize.x!==q.shadow){L.shadow.mapSize.set(q.shadow,q.shadow);if(L.shadow.map){L.shadow.map.dispose();L.shadow.map=null}}
  this.ground.visible=q.shadow>0;this.pets.forEach(p=>this._applyFur(p));this.stats.level=this.level;this._gaps.length=0;
  this._applyLighting()}
 /* Apply the lighting preset + brightness. Traverses the scene to push the
    environment-map intensity onto every PBR material, so a fresh pet added
    later picks it up from its own _applyLighting() call in add(). */
 _applyLighting(){const lvl=this._lighting==='auto'?this.level:({low:0,medium:1,high:2}[this._lighting]??1);const L=LIGHTING[lvl]||LIGHTING[1],s=this._lightingIntensity;
  this.key.intensity=L.key*s;this.rim.intensity=L.rim*s;this.amb.intensity=L.amb*s;const env=L.env*s;
  this.scene.traverse(o=>{if(o.isMesh&&o.material){const ms=Array.isArray(o.material)?o.material:[o.material];for(const m of ms){if(m&&'envMapIntensity' in m)m.envMapIntensity=env}}})}
 _govern(gap,interval,now){this._gaps.push(gap);if(this._gaps.length<45)return;const avg=this._gaps.reduce((a,b)=>a+b,0)/this._gaps.length;this._gaps.length=0;this.stats.fps=1000/avg;
  if(!this._auto)return;
  if(avg>interval*1.45&&this.level>0){this.level--;this._downAt=now;this._applyQuality()}                                   // struggling -> step down
  else if(avg<interval*1.1&&this.level<2&&now-(this._downAt||-1e9)>60000&&now-(this._upAt||-1e9)>20000){this.level++;this._upAt=now;this._applyQuality()}} // comfortable -> step up (rarely)
 _tick(now){
  this._raf=requestAnimationFrame(this._tick);
  if(document.hidden)return;                                   // nothing is drawn while the window is hidden/minimised
  const q=QUALITY[this.level];let fps=Math.min(this.opt.fps,q.fps);
  if(this.pets.length&&this.pets.every(p=>p.state==='sleeping'))fps=Math.min(fps,15);   // sleeping pets need very few frames
  const interval=1000/fps;if(this._last&&now-this._last<interval-2)return;
  const gap=this._last?now-this._last:interval;this._last=now;const dt=Math.min(gap/1000,.05),t=now/1000;
  this._govern(gap,interval,now);
  const rd=this.renderer,cam=this.cam,cr=this.canvas.getBoundingClientRect();
  furTime(t);rd.info.reset();rd.setScissorTest(false);rd.clear();
  for(const p of this.pets){
   const b=p.element.getBoundingClientRect(),k=Math.min(1,dt*4);
   p.look.x+=(clamp1((this._px-(b.left+b.width/2))/(innerWidth*.4))-p.look.x)*k;p.look.y+=(clamp1((this._py-(b.top+b.height*.35))/(innerHeight*.4))-p.look.y)*k;
   p.visible=b.width>2&&b.height>2&&b.bottom>cr.top&&b.top<cr.bottom&&b.right>cr.left&&b.left<cr.right&&hostShown(p.element);
   if(!p.visible)continue;                                   // off-screen pets cost nothing
   (p.cfg.quad?animateQ:animate)(p,t,dt);p.zz.update(p.state==='sleeping',t,p.cfg.quad?.9:1.8);
   const qd=p.cfg.quad,asp=b.width/b.height,dist=Math.max(qd?8:8.5,4.8/(2*Math.tan(T.MathUtils.degToRad(16))*asp));
   cam.aspect=asp;cam.position.set(0,qd?2.2:2.5,dist);cam.lookAt(0,qd?1.4:1.35,0);cam.updateProjectionMatrix();
   const x=b.left-cr.left,y=cr.bottom-b.bottom;rd.setViewport(x,y,b.width,b.height);rd.setScissor(x,y,b.width,b.height);rd.setScissorTest(true);
   p.holder.visible=true;rd.render(this.scene,cam);p.holder.visible=false}
  this.stats.calls=rd.info.render.calls;this.stats.tris=rd.info.render.triangles}
}

export { PetStage, QUALITY, KINDS as PET_KINDS };
