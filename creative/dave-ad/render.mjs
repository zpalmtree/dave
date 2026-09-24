import { createCanvas } from 'canvas';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const W = 960, H = 540, FPS = 24, DUR = 13, BPM = 120;
const cv = createCanvas(W, H), c = cv.getContext('2d');
const C = { night:'#14243c', deep:'#0b172b', teal:'#54c8bb', mint:'#b5e8d2', cream:'#fff2d6', gold:'#f4bd67', coral:'#f38875', ink:'#243047', lilac:'#aaa0cf', pink:'#eea6c0' };
const clamp = (x,a=0,b=1) => Math.max(a,Math.min(b,x));
const ease = x => { x=clamp(x); return x*x*(3-2*x); };
const lerp = (a,b,k) => a+(b-a)*k;
const seg = (t,a,b) => ease((t-a)/(b-a));
const hash = n => { const x=Math.sin(n*127.1+78.233)*43758.5453; return x-Math.floor(x); };
const BOIL = t => Math.floor(t*12);
const jig = (t,k,a=1) => (hash(BOIL(t)*73+k)-.5)*a;
function rr(x,y,w,h,r,fill,stroke=null,sw=2){ c.beginPath();c.roundRect(x,y,w,h,r); if(fill){c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=sw;c.stroke();} }
function ellipse(x,y,rx,ry,fill,stroke=null,sw=2){ c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);if(fill){c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=sw;c.stroke();} }
function line(points,color,width=3){ c.beginPath();c.moveTo(...points[0]);for(let i=1;i<points.length;i++)c.lineTo(...points[i]);c.strokeStyle=color;c.lineWidth=width;c.lineCap='round';c.lineJoin='round';c.stroke(); }
function text(s,x,y,size,color=C.cream,weight=700,align='left'){c.font=`${weight} ${size}px sans-serif`;c.textAlign=align;c.fillStyle=color;c.fillText(s,x,y);}
function glow(x,y,r,col,alpha=1){const g=c.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,col);g.addColorStop(1,'transparent');c.save();c.globalAlpha*=alpha;c.fillStyle=g;c.fillRect(x-r,y-r,2*r,2*r);c.restore();}
function star(x,y,r,t,col=C.gold){c.save();c.translate(x,y);c.rotate(t*.3);c.beginPath();for(let i=0;i<8;i++){const a=i*Math.PI/4-Math.PI/2,q=i%2?r*.27:r;c.lineTo(Math.cos(a)*q,Math.sin(a)*q);}c.closePath();c.fillStyle=col;c.fill();c.restore();}
function paper(t){
  const g=c.createLinearGradient(0,0,960,540);g.addColorStop(0,C.night);g.addColorStop(.6,'#1e3450');g.addColorStop(1,C.deep);c.fillStyle=g;c.fillRect(0,0,W,H);
  glow(765,130,310,'#4c8b9a',.22);glow(105,500,260,'#bb718e',.13);
  for(let i=0;i<125;i++){const x=hash(i*3)*W,y=hash(i*3+1)*H;c.fillStyle=i%4?'rgba(255,244,218,.055)':'rgba(95,205,190,.08)';ellipse(x,y,hash(i*3+2)*1.3+.3,.6,c.fillStyle);}
  for(let i=0;i<5;i++){const y=95+i*96;c.save();c.globalAlpha=.045;c.strokeStyle=C.cream;c.lineWidth=2;c.beginPath();c.moveTo(-30,y);c.bezierCurveTo(270,y+15*Math.sin(t+i),650,y-20*Math.sin(t*.6+i),990,y+10);c.stroke();c.restore();}
}
function brushStroke(x0,y0,x1,y1,p,t,col=C.teal){
  c.save();c.globalAlpha*=.75;c.strokeStyle=col;c.lineCap='round';
  for(let i=0;i<14;i++){const off=(i-6.5)*4;c.lineWidth=2+hash(i+12)*4;c.beginPath();c.moveTo(x0,y0+off);c.quadraticCurveTo((x0+x1)/2,y0+off-60*Math.sin(p*Math.PI),lerp(x0,x1,p),lerp(y0,y1,p)+off+jig(t,i,3));c.stroke();}
  c.restore();
}
function bot(x,y,s,t,pose='idle'){
  c.save();c.translate(x,y+Math.sin(t*BPM/60*Math.PI*2)*3*s);c.scale(s,s);
  const wave=pose==='wave'?Math.sin(t*12)*.22:0, look=pose==='look'?.35:0;
  ellipse(0,111,104,15,'rgba(4,10,21,.33)');
  line([[-28,69],[-31,99]],C.ink,15);line([[31,69],[33,99]],C.ink,15);
  ellipse(-31,99,17,10,C.gold,C.ink,3);ellipse(33,99,17,10,C.gold,C.ink,3);
  line([[-78,1],[-99,30+8*Math.sin(t*3)]],C.ink,17);line([[-78,1],[-99,30+8*Math.sin(t*3)]],C.gold,12);
  ellipse(-102,34+8*Math.sin(t*3),14,13,C.gold,C.ink,3);
  const handX=pose==='paint'?112:pose==='wave'?92+12*wave:94, handY=pose==='paint'?-35:pose==='wave'?-82+12*wave:21;
  line([[78,3],[handX,handY]],C.ink,17);line([[78,3],[handX,handY]],C.gold,12);ellipse(handX,handY,15,13,C.gold,C.ink,3);
  c.save();c.rotate(.025*Math.sin(t*6)+jig(t,45,.009));
  rr(-86,-91,172,167,63,C.gold,C.ink,5);rr(-73,-80,146,127,48,'#f8cb80');
  ellipse(-54,-33,9,8,'rgba(232,124,110,.45)');ellipse(54,-33,9,8,'rgba(232,124,110,.45)');
  rr(-64,-65,128,84,29,C.deep,C.ink,4);
  if(pose==='blink'&&Math.sin(t*11)>0.65){line([[-36,-25],[-14,-25]],C.mint,4);line([[17,-25],[39,-25]],C.mint,4);}
  else {ellipse(-26+look*7,-25,8,13,C.mint);ellipse(28+look*7,-25,8,13,C.mint);ellipse(-23+look*7,-29,2,4,C.cream);ellipse(31+look*7,-29,2,4,C.cream);}
  c.strokeStyle=C.mint;c.lineWidth=4;c.beginPath();c.arc(2,-13,11,.15,Math.PI-.15);c.stroke();
  rr(-20,40,40,23,11,C.cream,C.ink,2);text('D',0,57,16,C.ink,900,'center');
  c.restore();
  line([[0,-91],[3,-122]],C.ink,6);ellipse(4,-126,11,11,C.teal,C.ink,3);glow(4,-126,43,C.teal,.2);
  if(pose==='paint'){line([[handX,handY],[handX+13,handY-63]],C.ink,7);line([[handX+13,handY-63],[handX+17,handY-79]],C.cream,10);}
  c.restore();
}
function bubble(x,y,w,h,alpha=1){c.save();c.globalAlpha*=alpha;rr(x,y,w,h,28,C.cream,C.ink,4);c.beginPath();c.moveTo(x+w-84,y+h-2);c.lineTo(x+w-67,y+h+26);c.lineTo(x+w-43,y+h-2);c.fillStyle=C.cream;c.fill();line([[x+w-84,y+h-2],[x+w-67,y+h+26],[x+w-43,y+h-2]],C.ink,4);c.restore();}
function fox(t,amount=1,moving=false){
  c.save();c.translate(401,286);c.scale(amount,amount);
  glow(0,-25,160,'#fb9d85',.17);
  for(let i=0;i<32;i++){const x=(hash(i+10)-.5)*520,y=(hash(i+40)-.5)*315+(moving?t*90%50:0);line([[x,y],[x-11,y+28]],'rgba(173,228,223,.23)',1.4);}
  // A rounded, painted fox silhouette with a tiny animated tail.
  const tail=moving?Math.sin(t*7)*18:0;
  c.beginPath();c.moveTo(70,58);c.quadraticCurveTo(163,25+tail,186,-88+tail);c.quadraticCurveTo(192,27+tail,126,90);c.closePath();c.fillStyle=C.coral;c.fill();c.strokeStyle=C.ink;c.lineWidth=5;c.stroke();
  c.beginPath();c.moveTo(-130,78);c.quadraticCurveTo(-105,-82,-80,-84);c.lineTo(-54,-137);c.lineTo(-20,-103);c.quadraticCurveTo(16,-108,37,-100);c.lineTo(80,-138);c.lineTo(94,-61);c.quadraticCurveTo(126,1,102,75);c.quadraticCurveTo(0,130,-130,78);c.closePath();c.fillStyle=C.coral;c.fill();c.strokeStyle=C.ink;c.lineWidth=5;c.stroke();
  c.beginPath();c.moveTo(-101,36);c.quadraticCurveTo(-40,113,0,82);c.quadraticCurveTo(58,112,92,33);c.quadraticCurveTo(32,54,0,47);c.quadraticCurveTo(-59,61,-101,36);c.fillStyle=C.cream;c.fill();
  c.beginPath();c.moveTo(-54,-113);c.lineTo(-45,-73);c.lineTo(-31,-91);c.closePath();c.fillStyle=C.pink;c.fill();
  c.beginPath();c.moveTo(53,-94);c.lineTo(76,-116);c.lineTo(77,-67);c.closePath();c.fillStyle=C.pink;c.fill();
  const blink=moving&&Math.sin(t*5.2)>.94;
  if(blink){line([[-64,-5],[-34,-5]],C.ink,4);line([[36,-5],[66,-5]],C.ink,4);}else{ellipse(-48,-7,7,10,C.ink);ellipse(51,-7,7,10,C.ink);}
  ellipse(1,47,10,7,C.ink);line([[0,53],[0,64],[-12,67]],C.ink,3);line([[0,64],[12,67]],C.ink,3);
  for(let j of [-1,1]){line([[j*47,52],[j*116,40]],C.ink,2);line([[j*49,62],[j*115,66]],C.ink,2);}
  c.restore();
}
function picture(t,local,moving=false){
  const reveal=seg(local,.15,1.3), x=103,y=114,w=610,h=338;
  c.save();c.globalAlpha*=reveal;rr(x-10,y-10,w+20,h+20,26,'#354663',C.cream,3);c.beginPath();c.roundRect(x,y,w,h,18);c.clip();
  const g=c.createLinearGradient(0,y,0,y+h);g.addColorStop(0,'#394c77');g.addColorStop(.58,'#65658d');g.addColorStop(1,'#1a3446');c.fillStyle=g;c.fillRect(x,y,w,h);
  glow(420,205,200,'#e2a0a4',.3);ellipse(250,205,52,52,'#e9d4bd');
  for(let i=0;i<12;i++){const bx=x+i*55-4,bh=70+hash(i)*100;rr(bx,y+h-bh,38,bh,2,'#21344b');for(let j=0;j<4;j++)rr(bx+8+j*7,y+h-bh+15,3,6,1,'rgba(246,196,131,.3)');}
  fox(t,.94,moving);
  for(let i=0;i<75;i++){const px=x+hash(i*7+1)*w, py=y+((hash(i*7+2)*h+(moving?t*90:0))%h);line([[px,py],[px-8,py+24]],'rgba(193,231,226,.25)',1);}
  c.restore();
  if(moving&&reveal>.9){rr(125,130,72,28,14,'rgba(20,36,60,.75)',C.mint,1);ellipse(143,144,4,4,C.coral);text('VIDEO',155,149,12,C.cream,800);rr(122,419,570,5,3,'rgba(255,242,214,.3)');rr(122,419,360+125*Math.sin(t*.2),5,3,C.teal);}
  else if(reveal>.8){rr(125,130,72,28,14,'rgba(20,36,60,.75)',C.mint,1);text('IMAGE',139,149,12,C.cream,800);}
}
function shotOne(t){
  let a=seg(t,0,.45)*(1-seg(t,3.05,3.6));c.save();c.globalAlpha=a;
  text('A SPARK IN THE CHAT',79,102,20,C.mint,800);
  const bx=lerp(-370,80,seg(t,.1,.8));bubble(bx,165,507,154);
  text('a neon fox',bx+38,224,37,C.ink,800);text('in the rain...',bx+38,274,37,C.ink,800);
  const sx=624+55*seg(t,1.7,2.2),sy=213-26*seg(t,1.7,2.2);
  if(t>1.4){glow(sx,sy,58,C.gold,.36);star(sx,sy,17,t,C.gold);}
  bot(755,359,.72,t,t<1.5?'idle':t<2.45?'look':'paint');
  if(t>2.7)brushStroke(815,335,170,175,seg(t,2.7,3.55),t,C.teal);
  c.restore();
}
function shotTwo(t){const l=t-3.3,a=seg(t,3.2,3.7)*(1-seg(t,7.15,7.7));c.save();c.globalAlpha=a;picture(t,l);bot(830,359,.57,t,'paint');
  text('MAKE IT REAL',110,84,20,C.mint,800);if(l>1.1){const q=seg(l,1.1,1.75);c.save();c.globalAlpha*=q;text('An image, from an idea.',112,489,23,C.cream,700);c.restore();}
  for(let i=0;i<8;i++){const p=seg(l,.4+i*.14,1.4+i*.14);if(p>0&&p<1)star(158+i*65,100+12*Math.sin(i*2),5+4*p,t+i,C.gold);}
  c.restore();}
function shotThree(t){const l=t-7.4,a=seg(t,7.2,7.8)*(1-seg(t,10.1,10.6));c.save();c.globalAlpha=a;picture(t,2,true);bot(830,359,.57,t,'wave');
  text('NOW LET IT MOVE',110,84,20,C.mint,800);text('A video, ready to share.',112,489,23,C.cream,700);
  for(let i=0;i<4;i++)star(752+i*48,183+Math.sin(t*3+i)*30,6,t+i,C.gold);
  c.restore();}
function shotFour(t){const l=t-10.25,a=seg(t,10.1,10.75);c.save();c.globalAlpha=a;
  glow(492,270,290,C.teal,.22);ellipse(477,269,218+8*Math.sin(t*2),218+8*Math.sin(t*2),null,'rgba(181,232,210,.22)',2);
  bot(247,329,.77,t,'wave');
  text('DAVE',357,275,105,C.cream,900);line([[361,293],[747,293]],C.teal,6);
  text('Your creative sidekick in chat.',363,345,25,C.mint,700);
  text('DISCORD  •  IMAGES  •  VIDEO  •  MORE',363,386,13,C.lilac,800);
  for(let i=0;i<7;i++){const angle=i*6.28/7+t*.22;star(481+240*Math.cos(angle),267+215*Math.sin(angle),5+i%3,t+i,i%2?C.gold:C.teal);}
  c.restore();}
function frame(t){paper(t);shotOne(t);shotTwo(t);shotThree(t);shotFour(t);let fade=1-seg(t,12.58,13);if(fade<1){c.fillStyle=`rgba(11,23,43,${1-fade})`;c.fillRect(0,0,W,H);}}

// Short original plucked melody, warm bass, rhythm, and transition effects.
function audio(){
 const sr=44100,n=Math.round(DUR*sr),samples=new Float32Array(n),beat=60/BPM;
 function add(start,dur,freq,amp=.2,type='pluck'){
  const a=Math.max(0,Math.floor(start*sr)),end=Math.min(n,Math.floor((start+dur)*sr));
  for(let i=a;i<end;i++){const u=(i/sr-start),phase=2*Math.PI*freq*u;let v;
   if(type==='bass')v=Math.sin(phase)+.2*Math.sin(phase*2);
   else if(type==='noise')v=(hash(i*5+13)-.5)*2;
   else v=Math.sin(phase)+.35*Math.sin(phase*2)+.16*Math.sin(phase*3);
   const env=type==='noise'?Math.sin(Math.PI*u/dur)**2:type==='bass'?(1-Math.exp(-u*35))*Math.exp(-u*3):Math.min(1,u*85)*Math.exp(-u*5.2);
   samples[i]+=v*amp*env;
  }
 }
 const melody=[293.66,369.99,440,587.33,440,369.99,329.63,440,587.33,659.25,587.33,440,369.99,440,587.33,739.99,659.25,587.33,440,369.99,440,587.33,659.25,587.33,440,369.99];
 for(let b=0;b<26;b++){add(b*beat,.38,melody[b],.14);if(b%2===0)add(b*beat,.13,110,.21,'bass');if(b%4===2)add(b*beat,.08,82.41,.17,'bass');add(b*beat,.035,1400,.026,'noise');if(b%2)add(b*beat,.07,2600,.02,'noise');}
 for(const s of [2.8,3.4,7.4,10.35]){add(s,.42,220,.06,'noise');add(s+.08,.5,740,.08);}
 for(const s of [1.75,4.35,5.05,8.1,10.6])add(s,.48,880,.1);
 const out=Buffer.alloc(44+n*2);out.write('RIFF',0);out.writeUInt32LE(36+n*2,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(sr,24);out.writeUInt32LE(sr*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++){const fade=Math.min(1,i/(sr*.18),(n-i)/(sr*.35));out.writeInt16LE(Math.round(clamp(samples[i]*fade,-.98,.98)*32767),44+i*2);}return out;
}
function contactSheet(){const w=320,h=180,cols=3,rows=3,sheet=createCanvas(w*cols,h*rows),sc=sheet.getContext('2d');const ts=[.8,2.1,3.1,4.3,5.8,7.1,8.3,10.9,12.2];ts.forEach((t,i)=>{frame(t);sc.drawImage(cv,(i%cols)*w,Math.floor(i/cols)*h,w,h);});writeFileSync(join(DIR,'contact-sheet.jpg'),sheet.toBuffer('image/jpeg',{quality:.9}));}

contactSheet();
const soundtrack=join(DIR,'soundtrack.wav');writeFileSync(soundtrack,audio());
const ff=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate',String(FPS),'-vcodec','png','-i','-','-i',soundtrack,'-map','0:v','-map','1:a','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart','-shortest',join(DIR,'dave-ad.mp4')],{stdio:['pipe','inherit','inherit']});
for(let i=0;i<DUR*FPS;i++){frame(i/FPS);if(!ff.stdin.write(cv.toBuffer('image/png')))await new Promise(resolve=>ff.stdin.once('drain',resolve));if(i%48===0)console.log(`Rendered ${i}/${DUR*FPS}`);}
ff.stdin.end();const code=await new Promise(resolve=>ff.once('close',resolve));if(code!==0)throw new Error(`ffmpeg exited ${code}`);
console.log(`Wrote ${join(DIR,'dave-ad.mp4')}`);
