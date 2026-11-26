// Recognize the visible public badge shape, not its color or account data.
// Reference: the female symbol visually verified in the saved real-page scene.
// Unsupported shapes (including ambiguous or unrenderable SVGs) stay unknown.
async function readVisibleGenderGlyphs() {
 const reference=['000000111111000','000011110011100','000011000000110','000110000000110','000110000000010','000110000000011','000110000000010','000110000000110','110011000001110','111111111111100','011110111110000','011110000000000','111111000000000','110011000000000','100000000000000'].join('')
 const header=document.querySelector('[data-e2e="user-info"]'),scope=header?.parentElement
 if(!scope)return null
 const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}
 const nodes=[...scope.querySelectorAll('svg')].filter(n=>{const r=n.getBoundingClientRect();return visible(n)&&r.width<=40&&r.height<=40&&/^\s*\d{1,3}\s*岁\s*$/.test(n.parentElement?.innerText||'')}).slice(0,4)
 for(const node of nodes){
  try{
   const clone=node.cloneNode(true),original=[node,...node.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')]
   if(clone.querySelector('use,image,foreignObject,script'))continue // No external references or executable content.
   for(let i=0;i<original.length;i++){
    const style=getComputedStyle(original[i]);for(const key of ['fill','stroke'])copies[i].style.setProperty(key,style[key]==='none'?'none':'black')
    for(const key of ['stroke-width','stroke-linecap','stroke-linejoin','fill-rule'])copies[i].style.setProperty(key,style.getPropertyValue(key))
   }
   clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width','60');clone.setAttribute('height','60')
   const canvas=document.createElement('canvas');canvas.width=60;canvas.height=60
   const context=canvas.getContext('2d'),img=new Image();let timer
   try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;timer=setTimeout(()=>reject(Error('glyph timeout')),250);img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(clone))})}finally{clearTimeout(timer)}
   context.drawImage(img,0,0,60,60);const data=context.getImageData(0,0,60,60).data,pts=[]
   for(let y=0;y<60;y++)for(let x=0;x<60;x++)if(data[(y*60+x)*4+3]>100)pts.push([x,y])
   if(!pts.length)continue
   const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),left=Math.min(...xs),top=Math.min(...ys),width=Math.max(...xs)-left+1,height=Math.max(...ys)-top+1
   if(width/height<.8||width/height>1.2)continue
   const mask=new Set(pts.map(([x,y])=>Math.min(14,Math.floor((x-left)*15/width))+15*Math.min(14,Math.floor((y-top)*15/height))))
   let hit=0,total=0;for(let i=0;i<225;i++){if(reference[i]==='1')total++;if(reference[i]==='1'&&mask.has(i))hit++}
   const score=2*hit/(total+mask.size)
   if(score>=.86)return {value:'女',source:'visible_gender_badge_shape',template:'observed-female-symbol-v1',score:Math.round(score*1000)/1000}
  }catch{} // A failed glyph read cannot turn an unknown field into a fact.
 }
 return null
}
module.exports={readVisibleGenderGlyphs}
