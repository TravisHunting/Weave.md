// Keep a scrollbar drag tied to the pointer while CodeMirror refines the
// heights of offscreen rows. Native thumb dragging uses a stale scroll extent.
// Wheel, touch and keyboard scrolling still use the actual scroll container.
export function articleScrollbar(scroller, content) {
  const track = document.createElement('div'), thumb = document.createElement('div');
  track.className = 'article-scrollbar'; track.hidden = true;
  thumb.className = 'article-scroll-thumb'; thumb.tabIndex = 0;
  thumb.setAttribute('role','scrollbar'); thumb.setAttribute('aria-label','Article scroll position');
  thumb.setAttribute('aria-orientation','vertical'); thumb.setAttribute('aria-controls',scroller.id);
  thumb.setAttribute('aria-valuemin','0'); thumb.setAttribute('aria-valuemax','100');
  track.append(thumb); document.body.append(track); scroller.classList.add('article-scroll-container');
  let drag = null, frame = 0, endFrames = 0;
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  function measure() {
    frame = 0;
    const rect = scroller.getBoundingClientRect(), style = getComputedStyle(scroller);
    const header = scroller.querySelector(':scope > .tab-bar');
    const top = Math.max(0,rect.top,header?.getBoundingClientRect().bottom || 0), height = Math.min(innerHeight,rect.bottom)-top;
    const extent = scroller.scrollHeight-scroller.clientHeight;
    const visible = rect.width > 0 && height > 0 && extent > 1 && ['auto','scroll'].includes(style.overflowY);
    track.hidden = !visible;
    if (!visible) {drag = null; return;}
    track.style.cssText = `left:${rect.right-(track.offsetWidth || 12)}px;top:${top}px;height:${height}px`;
    const size = clamp(height*scroller.clientHeight/scroller.scrollHeight,28,height);
    const travel = height-size;
    if (endFrames) {scroller.scrollTop=extent;endFrames--;}
    let offset = extent ? scroller.scrollTop/extent*travel : 0;
    if (drag) {
      offset = clamp(drag.y-top-drag.grab*size,0,travel);
      scroller.scrollTop = travel ? offset/travel*extent : 0;
    }
    thumb.style.height = size+'px'; thumb.style.transform = `translateY(${offset}px)`;
    thumb.setAttribute('aria-valuenow',String(Math.round(travel ? offset/travel*100 : 0)));
    if (drag || endFrames) schedule();
  }
  function schedule() {if (!frame) frame = requestAnimationFrame(measure);}
  track.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); endFrames=0; const box = thumb.getBoundingClientRect();
    drag = {y:event.clientY,grab:event.target===thumb ? clamp((event.clientY-box.top)/box.height,0,1) : .5};
    track.setPointerCapture(event.pointerId); thumb.focus({preventScroll:true}); schedule();
  };
  track.onpointermove = event => {if (drag) {drag.y=event.clientY;schedule();}};
  const release = () => {drag=null;schedule();};
  track.onpointerup = event => {release();if(track.hasPointerCapture(event.pointerId))track.releasePointerCapture(event.pointerId);};
  track.onpointercancel = track.onlostpointercapture = release;
  thumb.onkeydown = event => {
    endFrames=0;
    const offsets={ArrowDown:40,ArrowUp:-40,PageDown:scroller.clientHeight*.9,PageUp:-scroller.clientHeight*.9};
    if (Object.hasOwn(offsets,event.key)) scroller.scrollTop += offsets[event.key];
    else if(event.key==='Home')scroller.scrollTop=0;
    else if(event.key==='End') {scroller.scrollTop=scroller.scrollHeight;endFrames=8;}
    else return;
    event.preventDefault();schedule();
  };
  track.onwheel = event => {event.preventDefault();endFrames=0;scroller.scrollTop += event.deltaY*(event.deltaMode===1 ? 20 : event.deltaMode===2 ? scroller.clientHeight : 1);schedule();};
  scroller.addEventListener('scroll',schedule,{passive:true});
  const cancelEnd = () => {endFrames=0;};
  scroller.addEventListener('wheel',cancelEnd,{passive:true});scroller.addEventListener('pointerdown',cancelEnd);
  window.addEventListener('resize',schedule);
  // Capture ancestor scrolling too: the combined graph/article view moves the
  // article's own scrollport without necessarily resizing it.
  document.addEventListener('scroll',schedule,{capture:true,passive:true});
  const observer = new ResizeObserver(schedule); observer.observe(scroller); observer.observe(content);
  for (const child of scroller.children) observer.observe(child);
  const visibility = new MutationObserver(schedule); visibility.observe(scroller,{attributes:true});visibility.observe(document.body,{attributes:true,attributeFilter:['class']});
  schedule();
  return {destroy() {cancelAnimationFrame(frame);observer.disconnect();visibility.disconnect();track.remove();scroller.classList.remove('article-scroll-container');scroller.removeEventListener('scroll',schedule);scroller.removeEventListener('wheel',cancelEnd);scroller.removeEventListener('pointerdown',cancelEnd);window.removeEventListener('resize',schedule);document.removeEventListener('scroll',schedule,true);}};
}
