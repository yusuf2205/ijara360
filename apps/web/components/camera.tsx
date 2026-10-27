'use client';
import {useEffect,useRef,useState} from 'react';

type FaceDetectorLike={detect:(v:HTMLVideoElement)=>Promise<{boundingBox:DOMRectReadOnly}[]>};

/**
 * In-browser camera. For a face it opens the FRONT camera and shoots by itself once a single face is centred and
 * close enough (Shape Detection API where available, otherwise a short countdown). For a document it opens the
 * BACK camera with a manual shutter. The captured frame is resized and compressed to a JPEG, so a large phone
 * photo never fails the 8 MB upload limit.
 */
export function Camera({mode,title,onCapture,onCancel}:{mode:'face'|'document';title:string;onCapture:(b:Blob)=>void;onCancel:()=>void}){
  const videoRef=useRef<HTMLVideoElement>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const captured=useRef(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState(mode==='face'?'Смотрите в камеру':'Наведите на документ');

  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:mode==='face'?'user':{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
        if(cancelled){stream.getTracks().forEach(t=>t.stop());return;}
        streamRef.current=stream;
        const v=videoRef.current;
        if(v){v.srcObject=stream;await v.play().catch(()=>undefined);}
        if(mode==='face')runFaceAuto();
      }catch{setError('Не удалось открыть камеру. Разрешите доступ к камере в браузере или нажмите «Загрузить файл».');}
    })();
    return()=>{cancelled=true;streamRef.current?.getTracks().forEach(t=>t.stop());};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  function capture(){
    const v=videoRef.current;if(captured.current||!v||!v.videoWidth)return;captured.current=true;
    const limit=1600;const scale=Math.min(1,limit/Math.max(v.videoWidth,v.videoHeight));
    const w=Math.round(v.videoWidth*scale),h=Math.round(v.videoHeight*scale);
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    canvas.getContext('2d')!.drawImage(v,0,0,w,h); // the raw (un-mirrored) frame — the preview is mirrored only in CSS
    streamRef.current?.getTracks().forEach(t=>t.stop());
    canvas.toBlob(b=>{if(b)onCapture(b);},'image/jpeg',0.85);
  }

  function runFaceAuto(){
    const FD=(window as unknown as {FaceDetector?:new(o?:unknown)=>FaceDetectorLike}).FaceDetector;
    if(!FD){ // no face detection in this browser: shoot after a short countdown so it still fires by itself
      let n=3;setStatus('Снимок через 3…');
      const t=window.setInterval(()=>{n--;if(n<=0){window.clearInterval(t);setStatus('Снимаю…');capture();}else setStatus(`Снимок через ${n}…`);},1000);
      return;
    }
    const detector=new FD({maxDetectedFaces:1,fastMode:true});
    let stable=0;
    const loop=async()=>{
      const v=videoRef.current;if(captured.current||!v)return;
      try{
        const faces=await detector.detect(v);
        if(faces.length===1){
          const b=faces[0].boundingBox;
          const big=b.width>v.videoWidth*0.18;
          const cx=b.x+b.width/2,cy=b.y+b.height/2;
          const centered=Math.abs(cx-v.videoWidth/2)<v.videoWidth*0.28&&Math.abs(cy-v.videoHeight/2)<v.videoHeight*0.34;
          if(big&&centered){stable++;setStatus('Не двигайтесь…');if(stable>=4){capture();return;}}
          else{stable=0;setStatus(big?'Поместите лицо в овал':'Подойдите ближе');}
        }else{stable=0;setStatus(faces.length>1?'В кадре должен быть один человек':'Лицо не найдено');}
      }catch{/* a detector hiccup — keep trying */}
      window.setTimeout(loop,250);
    };
    loop();
  }

  return <div className="camera-overlay" role="dialog" aria-label={title}>
    <div className="camera-bar"><span>{title}</span><button type="button" className="camera-x" onClick={onCancel} aria-label="Закрыть">✕</button></div>
    <div className="camera-stage">
      {error?<p className="camera-error">{error}</p>:<>
        <video ref={videoRef} playsInline muted className={`camera-video${mode==='face'?' mirror':''}`}/>
        <div className={`camera-guide ${mode}`}/>
        <p className="camera-status">{status}</p>
      </>}
    </div>
    <div className="camera-actions">
      <button type="button" className="button secondary" onClick={onCancel}>Отмена</button>
      {!error&&<button type="button" className="button primary" onClick={capture}>Сфотографировать</button>}
    </div>
  </div>;
}
