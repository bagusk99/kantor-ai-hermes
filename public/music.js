(() => {
  const button=document.getElementById('bMusic'),volume=document.getElementById('musicVolume');
  let context,master,timer,enabled=false,nextTime=0,beat=0,scheduled=0;
  const notes=[ [48,55,59,62], [45,52,55,59], [41,48,52,57], [43,50,53,57] ];
  const melody=[72,null,74,79,76,null,74,null,71,null,72,76,74,null,71,null];
  const tempo=60/72;
  try{const saved=localStorage.getItem('kantor-ai.music-volume');if(saved!==null&&Number.isFinite(Number(saved)))volume.value=String(Math.max(0,Math.min(100,Number(saved))));}catch{}
  const gain=()=>Number(volume.value)/100*.32;
  function note(midi,time,duration,loudness,type='sine'){
    const oscillator=context.createOscillator(),envelope=context.createGain(),filter=context.createBiquadFilter();
    oscillator.type=type;oscillator.frequency.value=440*2**((midi-69)/12);
    filter.type='lowpass';filter.frequency.value=1600;
    envelope.gain.setValueAtTime(0,time);envelope.gain.linearRampToValueAtTime(loudness,time+.09);
    envelope.gain.exponentialRampToValueAtTime(.0001,time+duration);
    oscillator.connect(filter);filter.connect(envelope);envelope.connect(master);
    oscillator.start(time);oscillator.stop(time+duration+.02);
    oscillator.onended=()=>{oscillator.disconnect();filter.disconnect();envelope.disconnect();};scheduled++;
  }
  function schedule(){
    if(!enabled||context.state!=='running')return;
    // Schedule against the audio clock, avoiding accumulated interval drift.
    if(nextTime<context.currentTime)nextTime=context.currentTime+.04;
    while(nextTime<context.currentTime+.4){
      const chord=notes[Math.floor(beat/8)%notes.length];
      if(beat%8===0){chord.forEach((m,i)=>note(m,nextTime+i*.045,tempo*7.5,.13,'triangle'));note(chord[0]-12,nextTime,tempo*4,.18);}
      const top=melody[beat%melody.length];if(top!==null)note(top,nextTime,tempo*1.8,.13);
      beat++;nextTime+=tempo;
    }
  }
  button.onclick=async()=>{
    button.disabled=true;
    try{
      if(!context){
        const Audio=window.AudioContext||window.webkitAudioContext;
        if(!Audio)throw new Error('Audio unavailable');
        context=new Audio();master=context.createGain();master.gain.value=gain();master.connect(context.destination);
      }
      if(enabled){enabled=false;clearInterval(timer);await context.suspend();}
      else{await context.resume();if(context.state!=='running')throw new Error('Audio not allowed yet');enabled=true;nextTime=context.currentTime+.05;schedule();timer=setInterval(schedule,100);}
      button.textContent=enabled?'Music: on':'Music';button.setAttribute('aria-pressed',String(enabled));button.setAttribute('aria-label',enabled?'Turn off relaxing music':'Play relaxing music');
    }catch{enabled=false;clearInterval(timer);button.textContent='Try music';button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Try playing relaxing music');document.getElementById('sceneStatus').textContent='Music could not play. Press Try music to try again.';}
    finally{button.disabled=false;}
  };
  volume.oninput=()=>{
    if(master)master.gain.setTargetAtTime(gain(),context.currentTime,.08);
    try{localStorage.setItem('kantor-ai.music-volume',volume.value);}catch{}
  };
  addEventListener('pagehide',()=>{clearInterval(timer);if(context)context.close();});
  window.officeMusic={snapshot:()=>({enabled,state:context?.state||'off',volume:Number(volume.value),scheduled})};
})();
