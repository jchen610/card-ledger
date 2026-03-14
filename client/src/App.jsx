import { useState, useEffect, useMemo, useRef } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const CONDITIONS        = ["Mint","Near Mint","Excellent","Good","Light Played","Played","Poor"];
const GRADING_COMPANIES = ["PSA","BGS","CGC","SGC","ACE"];
const GRADING_GRADES    = {
  PSA: ["PSA 10","PSA 9","PSA 8.5","PSA 8","PSA 7","PSA 6","PSA 5","PSA 4","PSA 3","PSA 2","PSA 1"],
  BGS: ["BGS 10 Black","BGS 10 Pristine","BGS 9.5 Gem Mint","BGS 9 Mint","BGS 8.5","BGS 8","BGS 7.5","BGS 7"],
  CGC: ["CGC 10 Pristine","CGC 10 Perfect","CGC 9.5","CGC 9","CGC 8.5","CGC 8","CGC 7.5","CGC 7"],
  SGC: ["SGC 10","SGC 9.5","SGC 9","SGC 8.5","SGC 8","SGC 7.5","SGC 7"],
  ACE: ["ACE 10","ACE 9","ACE 8","ACE 7"],
};
const BLANK_CARD = {
  name:"", isGraded:true, gradingCompany:"PSA", grade:"PSA 10",
  condition:"Near Mint", buyPrice:"", marketAtPurchase:"", currentMarket:"",
  currentMarketTouched: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt         = n => `$${Math.abs(n).toFixed(2)}`;
const pct         = n => `${n.toFixed(1)}%`;
const pillCls     = v => v < 75 ? "pct-good" : v < 90 ? "pct-mid" : "pct-low";
const salePillCls = v => v >= 95 ? "pct-good" : v >= 80 ? "pct-mid" : "pct-low";
const toF         = s => parseFloat(s) || 0;

const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`API ${path} → ${r.status}`);
  return r.json();
};

// ─── Signed URL hook (passthrough — images are public URLs) ──────────────────
function useSignedUrl(rawUrl) { return rawUrl || ''; }

// SecureImage — plain img wrapper, no signing needed for public S3
function SecureImage({ src, alt, style, onClick, onError }) {
  if (!src) return null;
  return <img src={src} alt={alt||''} style={style}
    onClick={onClick ? () => onClick(src) : undefined}
    onError={onError || (e => { e.target.style.display='none'; })}/>;
}

// ─── AltLookup ────────────────────────────────────────────────────────────────
// Paste an alt.app.link or alt.xyz URL to auto-populate the card name field.
function AltLookup({ onResult }) {
  const [url,     setUrl]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [hint,    setHint]    = useState("");
  const [ok,      setOk]      = useState(false);

  async function handleLookup() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(""); setHint(""); setOk(false);
    try {
      const resp = await fetch(`/api/alt-lookup?url=${encodeURIComponent(trimmed)}`);
      let data;
      const text = await resp.text();
      try { data = JSON.parse(text); }
      catch { setError(`Server returned non-JSON (status ${resp.status}): ${text.slice(0,120)}`); setLoading(false); return; }
      if (data.cardName) {
        onResult(data);
        setOk(true);
        setUrl("");
      } else {
        setError(data.error || "No card name found");
        if (data.tip) setHint(data.tip);
        if (data.bodySnippet) setHint(h => h + " | page: " + data.bodySnippet.slice(0,80));
      }
    } catch (e) {
      setError("Network error: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{marginBottom:10}}>
      <label style={{color:"#555",fontSize:10,letterSpacing:1.5,textTransform:"uppercase",marginBottom:4,display:"block"}}>
        Alt.xyz Link <span style={{color:"#333",fontWeight:400,letterSpacing:0,textTransform:"none"}}>— paste to auto-fill name</span>
      </label>
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <input
          className="input"
          style={{flex:1,fontSize:11,borderColor: ok?"#4ade8044":error?"#f8717144":"#1e1e28"}}
          placeholder="https://alt.app.link/... or https://alt.xyz/..."
          value={url}
          onChange={e=>{ setUrl(e.target.value); setError(""); setHint(""); setOk(false); }}
          onKeyDown={e=>e.key==="Enter"&&(e.preventDefault(),handleLookup())}
        />
        <button
          type="button"
          onClick={async()=>{ try { const t=await navigator.clipboard.readText(); setUrl(t.trim()); setError(""); setHint(""); setOk(false); } catch{ setError("Clipboard access denied"); } }}
          title="Paste from clipboard"
          style={{
            padding:"5px 10px",borderRadius:3,fontSize:11,cursor:"pointer",flexShrink:0,
            background:"#12121e",color:"#888",border:"1px solid #252535",
            fontFamily:"'Space Mono',monospace",whiteSpace:"nowrap",
          }}>
          📋
        </button>
        <button
          type="button"
          onClick={handleLookup}
          disabled={!url.trim()||loading}
          style={{
            padding:"5px 12px",borderRadius:3,fontSize:10,cursor:"pointer",flexShrink:0,
            background: loading?"#1a1a1a":"#1a1208",
            color: loading?"#555":"#f5a623",
            border:`1px solid ${loading?"#333":"#f5a62344"}`,
            fontFamily:"'Space Mono',monospace",whiteSpace:"nowrap",
            opacity: !url.trim()||loading ? 0.5 : 1,
          }}>
          {loading?"..." : "↓ Fill"}
        </button>
      </div>
      {error&&<div style={{fontSize:10,color:"#f87171",marginTop:3}}>{error}</div>}
      {hint&&<div style={{fontSize:10,color:"#f5a623",marginTop:2}}>{hint}</div>}
      {ok&&<div style={{fontSize:10,color:"#4ade80",marginTop:3}}>✓ Card name filled in</div>}
    </div>
  );
}


// Supports: camera capture, file upload, or manual URL entry.
// Uploads files to /api/upload and stores the returned server path.
function ImagePicker({ value, onChange, label = "Photo (optional)" }) {
  const fileRef   = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab]             = useState("camera"); // "camera" | "url"
  const [urlDraft, setUrlDraft]   = useState(value || "");

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error("Upload failed");
      const { url } = await r.json();
      onChange(url);
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function handleUrlCommit() {
    onChange(urlDraft.trim());
  }

  return (
    <div>
      <label style={{display:"block",fontSize:10,letterSpacing:1.5,color:"#555",marginBottom:6,textTransform:"uppercase"}}>{label}</label>

      {/* Tab strip */}
      <div style={{display:"flex",gap:6,marginBottom:8}}>
        {[{k:"camera",l:"📷 Camera / File"},{k:"url",l:"🔗 URL"}].map(t => (
          <button
            key={t.k}
            type="button"
            onClick={() => setTab(t.k)}
            style={{
              background: tab===t.k ? "#f5a623" : "#141420",
              color: tab===t.k ? "#0a0a0f" : "#888",
              border: `1px solid ${tab===t.k ? "#f5a623" : "#252535"}`,
              borderRadius: 3, padding: "4px 12px", cursor: "pointer",
              fontFamily: "'Space Mono', monospace", fontSize: 10,
              letterSpacing: 1, textTransform: "uppercase", fontWeight: tab===t.k ? 700 : 400,
            }}
          >{t.l}</button>
        ))}
        {value && (
          <button type="button" onClick={() => { onChange(""); setUrlDraft(""); }}
            style={{marginLeft:"auto",background:"#2a0a0a",color:"#f87171",border:"1px solid #7f1d1d44",borderRadius:3,padding:"4px 10px",cursor:"pointer",fontSize:10,fontFamily:"'Space Mono',monospace"}}>
            ✕ Remove
          </button>
        )}
      </div>

      {/* Camera / file tab */}
      {tab === "camera" && (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={handleFile}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{
              width:"100%", padding:"10px", background:"#0c0c18",
              border:"1px dashed #f5a62366", borderRadius:4, color: uploading ? "#555" : "#f5a623",
              cursor: uploading ? "not-allowed" : "pointer",
              fontFamily:"'Space Mono',monospace", fontSize:12, letterSpacing:1,
            }}
          >
            {uploading ? "⏳ Uploading..." : "📷 Take Photo or Choose File"}
          </button>
          <div style={{fontSize:9,color:"#444",marginTop:4}}>
            On mobile this opens your camera. On desktop it opens file picker.
          </div>
        </div>
      )}

      {/* URL tab */}
      {tab === "url" && (
        <div style={{display:"flex",gap:6}}>
          <input
            className="input"
            style={{flex:1}}
            value={urlDraft}
            onChange={e => setUrlDraft(e.target.value)}
            onBlur={handleUrlCommit}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleUrlCommit(); } }}
            placeholder="https://image.host/card.jpg"
          />
        </div>
      )}

      {/* Preview */}
      {value && (
        <div style={{marginTop:8,borderRadius:4,overflow:"hidden",border:"1px solid #252535",
          maxHeight:160,display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0a0f"}}>
          <SecureImage
            src={value}
            alt="preview"
            style={{maxWidth:"100%",maxHeight:160,objectFit:"contain"}}
            onError={e => { e.target.style.display = "none"; }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function GradeTag({ card, small }) {
  if (!card) return null;
  if (card.isGraded && card.grade) {
    const c = {
      PSA:{bg:"#1c1030",color:"#a78bfa",border:"#7c3aed44"},
      BGS:{bg:"#0d1f33",color:"#60a5fa",border:"#2563eb44"},
      CGC:{bg:"#1a1a0a",color:"#facc15",border:"#ca8a0444"},
      SGC:{bg:"#0d2010",color:"#4ade80",border:"#16a34a44"},
      ACE:{bg:"#1a0d0d",color:"#fb923c",border:"#c2410c44"},
    }[card.gradingCompany] || {bg:"#1c1030",color:"#a78bfa",border:"#7c3aed44"};
    return (
      <span style={{display:"inline-flex",alignItems:"center",background:c.bg,color:c.color,
        border:`1px solid ${c.border}`,borderRadius:3,padding:small?"1px 6px":"2px 8px",
        fontSize:small?9:10,fontWeight:700,whiteSpace:"nowrap"}}>
        {card.grade}
      </span>
    );
  }
  return (
    <span style={{display:"inline-block",background:"#1a1a1a",color:"#666",border:"1px solid #2a2a2a",
      borderRadius:3,padding:small?"1px 6px":"2px 8px",fontSize:small?9:10,fontWeight:700}}>
      RAW · {card.condition}
    </span>
  );
}

function GradeFields({ data, onChange }) {
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{display:"inline-block",width:38,height:20,borderRadius:20,cursor:"pointer",
          position:"relative",background:data.isGraded?"#f5a623":"#252535",transition:"0.2s"}}
          onClick={() => onChange({...data, isGraded:!data.isGraded})}>
          <span style={{position:"absolute",top:3,left:data.isGraded?21:3,width:14,height:14,
            borderRadius:"50%",background:data.isGraded?"#0a0a0f":"#555",transition:"0.2s"}}/>
        </span>
        <span style={{fontSize:12,color:data.isGraded?"#f5a623":"#555"}}>
          {data.isGraded ? "Graded Slab" : "Raw Card"}
        </span>
      </div>
      {data.isGraded ? (
        <div className="grid2">
          <div>
            <label>Grading Company</label>
            <select className="select" value={data.gradingCompany}
              onChange={e => { const co=e.target.value; onChange({...data,gradingCompany:co,grade:GRADING_GRADES[co]?.[0]||""}); }}>
              {GRADING_COMPANIES.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label>Grade</label>
            <select className="select" value={data.grade}
              onChange={e => onChange({...data,grade:e.target.value})}>
              {(GRADING_GRADES[data.gradingCompany]||[]).map(g=><option key={g}>{g}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div>
          <label>Condition</label>
          <select className="select" value={data.condition}
            onChange={e => onChange({...data,condition:e.target.value})}>
            {CONDITIONS.map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function PricingFields({ data, onChange }) {
  const buyF = parseFloat(data.buyPrice)  || 0;
  const mktF = parseFloat(data.marketAtPurchase) || 0;
  // Displayed intake pct: if both filled, compute live; else use stored intakePct
  const computedPct = buyF > 0 && mktF > 0 ? ((buyF / mktF) * 100).toFixed(1) : "";
  const shownPct    = data.intakePct !== undefined ? data.intakePct : computedPct;

  function handleBuyChange(v) {
    const b = parseFloat(v) || 0;
    const m = parseFloat(data.marketAtPurchase) || 0;
    const newPct = b > 0 && m > 0 ? ((b / m) * 100).toFixed(1) : (data.intakePct ?? "");
    onChange({...data, buyPrice: v, intakePct: newPct});
  }
  function handleMktChange(v) {
    const m = parseFloat(v) || 0;
    const b = parseFloat(data.buyPrice) || 0;
    const p = parseFloat(data.intakePct) || 0;
    // If buyPrice is empty but pct is set, back-fill buyPrice
    const newBuy = (!data.buyPrice || data.buyPrice === "") && p > 0 && m > 0
      ? ((p / 100) * m).toFixed(2) : data.buyPrice;
    const newPct = newBuy && m > 0 ? ((parseFloat(newBuy) / m) * 100).toFixed(1) : (data.intakePct ?? "");
    onChange({...data, marketAtPurchase: v, buyPrice: newBuy,
      intakePct: newPct,
      currentMarket: data.currentMarketTouched ? data.currentMarket : v});
  }
  function handlePctChange(v) {
    const p = parseFloat(v) || 0;
    const m = parseFloat(data.marketAtPurchase) || 0;
    // If market is set, back-fill buyPrice
    const newBuy = p > 0 && m > 0 ? ((p / 100) * m).toFixed(2) : data.buyPrice;
    onChange({...data, intakePct: v, buyPrice: newBuy ?? data.buyPrice});
  }
  return (
    <div>
      <div className="grid3" style={{marginBottom:6}}>
        <div>
          <label style={{color:"#4ade80"}}>Market @ Purchase ($)</label>
          <input className="input" type="number" min="0" step="0.01" value={data.marketAtPurchase}
            onChange={e => handleMktChange(e.target.value)} placeholder="0.00"
            style={{borderColor:"#4ade8033"}}/>
        </div>
        <div>
          <label style={{color:"#f5a623",display:"flex",alignItems:"center",gap:6}}>
            % of Mkt
            {computedPct&&<span style={{fontSize:9,color:"#555",fontWeight:400}}>auto</span>}
          </label>
          <input className="input" type="number" min="0" max="200" step="0.1"
            value={shownPct}
            onChange={e => handlePctChange(e.target.value)}
            placeholder="e.g. 75"
            style={{borderColor:"#f5a62333"}}/>
          <div style={{display:"flex",gap:4,marginTop:4}}>
            {[70,75,80,85,90].map(p=>(
              <span key={p} onClick={()=>handlePctChange(String(p))}
                style={{cursor:"pointer",fontSize:9,padding:"2px 7px",borderRadius:3,userSelect:"none",
                  background: Math.abs(parseFloat(shownPct)-p)<0.1 ? "#f5a623" : "#1a1208",
                  color:       Math.abs(parseFloat(shownPct)-p)<0.1 ? "#0a0a0f" : "#f5a623",
                  border:`1px solid #f5a62344`,fontFamily:"'Space Mono',monospace"}}>
                {p}%
              </span>
            ))}
          </div>
        </div>
        <div>
          <label style={{color:"#f87171"}}>Buy Price ($)</label>
          <input className="input" type="number" min="0" step="0.01" value={data.buyPrice}
            onChange={e => handleBuyChange(e.target.value)} placeholder="0.00"
            style={{borderColor:"#f8717133"}}/>
        </div>
      </div>
      <div>
        <label>Current Market ($)</label>
        <input className="input" type="number" min="0" step="0.01"
          value={data.currentMarketTouched ? data.currentMarket : data.marketAtPurchase}
          onChange={e => onChange({...data, currentMarket:e.target.value, currentMarketTouched:true})}
          placeholder="Defaults to above"/>
        <div style={{fontSize:9,color:"#444",marginTop:3}}>Leave blank to match mkt @ purchase</div>
      </div>
    </div>
  );
}

function ModalShell({ title, onClose, children, wide }) {
  return (
    <div className="modal-overlay">
      <div className="modal" style={wide ? {maxWidth:860} : {}}>
        <div style={{padding:"18px 24px",borderBottom:"1px solid #1e1e28",display:"flex",
          justifyContent:"space-between",alignItems:"center"}}>
          <h3 style={{margin:0,fontFamily:"'Black Han Sans', sans-serif",color:"#f5a623",letterSpacing:2}}>
            {title}
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{padding:24}}>{children}</div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
// ── Buy payment method UI (used in Add Card + Batch Buy) ──────────────────────
function BuyPaymentUI({ payment, onChange, buyPrice }) {
  const toggle = m => {
    onChange({ ...payment, methods: payment.methods.includes(m)
      ? payment.methods.filter(x=>x!==m)
      : [...payment.methods, m] });
  };
  const set = k => v => onChange({ ...payment, [k]: v });

  const methods  = payment.methods;
  const amtKey   = { cash:"cashAmt", venmo:"venmoAmt", zelle:"zelleAmt" };
  const dirKey   = { cash:"cashDir", venmo:"venmoDir", zelle:"zelleDir" };
  const color    = { cash:"#4ade80", venmo:"#60a5fa", zelle:"#c084fc" };
  const icon     = { cash:"💵", venmo:"💙", zelle:"💜" };

  // Compute how much is already accounted for by filled fields
  const filledTotal = methods.reduce((s, m) => {
    const raw = parseFloat(payment[amtKey[m]]);
    return s + (isNaN(raw) ? 0 : raw);
  }, 0);
  const emptyMethods = methods.filter(m => !payment[amtKey[m]]);
  const remaining    = Math.max(0, (buyPrice || 0) - filledTotal);
  const autoAmt      = emptyMethods.length > 0
    ? parseFloat((remaining / emptyMethods.length).toFixed(2))
    : 0;

  return (
    <div style={{marginTop:10,padding:10,background:"#0a0a14",border:"1px solid #1e1e30",borderRadius:4}}>
      <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:8}}>Payment Method</div>

      {/* Method toggle buttons */}
      <div style={{display:"flex",gap:6,marginBottom:methods.length?8:0,flexWrap:"wrap"}}>
        {[["cash","💵 Cash"],["venmo","💙 Venmo"],["zelle","💜 Zelle"]].map(([m,label])=>(
          <button key={m} type="button" onClick={()=>toggle(m)}
            style={{padding:"4px 12px",borderRadius:3,fontSize:11,cursor:"pointer",fontFamily:"'Space Mono',monospace",
              background:methods.includes(m)?color[m]+"22":"transparent",
              color:methods.includes(m)?color[m]:"#555",
              border:`1px solid ${methods.includes(m)?color[m]+"55":"#252535"}`}}>
            {label}
          </button>
        ))}
      </div>

      {/* Per-method rows */}
      {methods.map(m => {
        const ak  = amtKey[m];
        const dk  = dirKey[m];
        const val = payment[ak] || "";
        const isEmpty = !val;
        const showAuto = buyPrice > 0 && isEmpty && autoAmt > 0;
        return (
          <div key={m} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
            <span style={{fontSize:11,color:color[m],width:20,flexShrink:0,textAlign:"center"}}>{icon[m]}</span>
            {/* Direction toggle */}
            <button type="button" onClick={()=>set(dk)(payment[dk]==="out"?"in":"out")}
              style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",flexShrink:0,
                background:payment[dk]==="out"?"#f8717122":"#4ade8022",
                color:payment[dk]==="out"?"#f87171":"#4ade80",
                border:"1px solid transparent",fontFamily:"'Space Mono',monospace"}}>
              {payment[dk]==="out"?"↑ Out":"↓ In"}
            </button>
            {/* Amount input */}
            <input className="input" type="number" min="0" step="0.01"
              placeholder={showAuto ? `auto ${autoAmt.toFixed(2)}` : "amount"}
              style={{flex:1,padding:"3px 8px",fontSize:12,
                borderColor: isEmpty && buyPrice>0 ? color[m]+"33" : undefined}}
              value={val}
              onChange={e=>set(ak)(e.target.value)}/>
            {/* Auto fill button */}
            {showAuto && (
              <button type="button" onClick={()=>set(ak)(autoAmt.toFixed(2))}
                style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",flexShrink:0,
                  background:color[m]+"22",color:color[m],border:`1px solid ${color[m]}44`,
                  fontFamily:"'Space Mono',monospace",whiteSpace:"nowrap"}}>
                ✓ {autoAmt.toFixed(2)}
              </button>
            )}
          </div>
        );
      })}

      {/* Total summary when multiple methods or mismatch */}
      {methods.length > 0 && buyPrice > 0 && (()=>{
        const enteredTotal = methods.reduce((s,m) => {
          const raw = parseFloat(payment[amtKey[m]]) || autoAmt;
          return s + (payment[amtKey[m]] ? parseFloat(payment[amtKey[m]]) : (emptyMethods.includes(m) ? autoAmt : 0));
        }, 0);
        const allFilled = emptyMethods.length === 0;
        const total = methods.reduce((s,m)=>s+(parseFloat(payment[amtKey[m]])||0),0);
        const diff  = total - buyPrice;
        if (!allFilled || Math.abs(diff)<0.01) return null;
        return (
          <div style={{fontSize:10,color:Math.abs(diff)<0.01?"#4ade80":"#f87171",marginTop:4,textAlign:"right"}}>
            entered {fmt(total)} / {fmt(buyPrice)} {Math.abs(diff)>0.01&&`(${diff>0?"+":"-"}${fmt(Math.abs(diff))})`}
          </div>
        );
      })()}
    </div>
  );
}

// ── Ownership split component ──────────────────────────────────────────────────
const PROFILE_COLORS = ['#f5a623','#4ade80','#60a5fa','#c084fc','#f87171','#fb923c','#34d399','#e879f9'];
const toTitleCase = s => (s||'').replace(/\w\S*/g, t => t.charAt(0).toUpperCase()+t.slice(1).toLowerCase());

function defaultOwners(profiles) {
  if (!profiles.length) return [];
  const each = parseFloat((100 / profiles.length).toFixed(2));
  return profiles.map((p, i) => ({
    profileId: p.id,
    name: p.name,
    color: p.color,
    initials: p.initials,
    // last person absorbs rounding remainder
    percentage: i === profiles.length - 1
      ? parseFloat((100 - each * (profiles.length - 1)).toFixed(2))
      : each,
  }));
}

function OwnershipSplit({ profiles, owners, onChange }) {
  const active = profiles.filter(p => !p.archived);
  if (!active.length) return null;
  const total = owners.reduce((s, o) => s + (parseFloat(o.percentage) || 0), 0);
  const totalOk = Math.abs(total - 100) < 0.1;

  return (
    <div style={{marginTop:10,padding:10,background:"#0a0a14",border:"1px solid #1e1e30",borderRadius:4}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase"}}>Ownership Split</div>
        <button type="button" className="btn btn-ghost btn-sm" style={{fontSize:10,padding:"2px 8px"}}
          onClick={() => onChange(defaultOwners(active))}>Even Split</button>
      </div>
      {active.map(p => {
        const o = owners.find(x => x.profileId === p.id);
        const percentage = o ? o.percentage : 0;
        return (
          <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:p.color,flexShrink:0}}/>
            <span style={{fontSize:11,color:"#aaa",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {p.name}
            </span>
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <input type="number" min="0" max="100" step="0.5"
                style={{width:64,background:"#0e0e18",border:`1px solid ${p.color}44`,borderRadius:3,
                  color:"#e8e4d9",padding:"2px 6px",fontSize:12,textAlign:"right"}}
                value={percentage}
                onChange={e => {
                  const val = parseFloat(e.target.value) || 0;
                  const existing = owners.filter(x => x.profileId !== p.id);
                  const updated  = val > 0
                    ? [...existing, {profileId:p.id,name:p.name,color:p.color,initials:p.initials,percentage:val}]
                    : existing;
                  onChange(updated);
                }}/>
              <span style={{fontSize:11,color:"#555",width:14}}>%</span>
            </div>
          </div>
        );
      })}
      <div style={{height:4,background:"#1a1a28",borderRadius:2,marginTop:8,overflow:"hidden"}}>
        {owners.filter(o => o.percentage > 0).map(o => (
          <div key={o.profileId} style={{display:"inline-block",height:"100%",
            width:`${Math.min(o.percentage, 100)}%`,background:o.color,transition:"width 0.2s"}}/>
        ))}
      </div>
      <div style={{fontSize:10,color:totalOk?"#4ade80":"#f87171",marginTop:4,textAlign:"right"}}>
        {total.toFixed(1)}% {totalOk ? "✓" : "(must equal 100%)"}
      </div>
    </div>
  );
}

// ─── Paginator ────────────────────────────────────────────────────────────────
function Paginator({ total, page, perPage, onPage, onPerPage, pageSizeOptions = [10, 20, 50, 100] }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage   = Math.min(page, totalPages - 1);
  const btnStyle   = (active, disabled) => ({
    padding:"4px 8px", border:"1px solid #252535", borderRadius:3, cursor: disabled?"not-allowed":"pointer",
    background: active?"#f5a623":"#12121e", color: active?"#0a0a0f": disabled?"#333":"#666",
    fontFamily:"'Space Mono',monospace", fontSize:10, opacity: disabled ? 0.4 : 1,
  });
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",
      borderTop:"1px solid #1a1a28",flexWrap:"wrap",gap:8}}>
      {/* Left: per-page selector */}
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:10,color:"#444"}}>Show</span>
        <select value={perPage} onChange={e=>{ onPerPage(Number(e.target.value)); onPage(0); }}
          style={{background:"#12121e",color:"#888",border:"1px solid #252535",borderRadius:3,
            padding:"3px 6px",fontSize:10,fontFamily:"'Space Mono',monospace",cursor:"pointer"}}>
          {pageSizeOptions.map(n=><option key={n} value={n}>{n}</option>)}
        </select>
        <span style={{fontSize:10,color:"#444"}}>per page</span>
        <span style={{fontSize:10,color:"#333",marginLeft:8}}>{total} total</span>
      </div>
      {/* Right: page controls */}
      {totalPages > 1 && (
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <button style={btnStyle(false, safePage===0)} disabled={safePage===0} onClick={()=>onPage(0)}>⟨⟨</button>
          <button style={btnStyle(false, safePage===0)} disabled={safePage===0} onClick={()=>onPage(safePage-1)}>⟨</button>
          <span style={{fontSize:10,color:"#555",padding:"0 8px",whiteSpace:"nowrap"}}>
            Page {safePage+1} of {totalPages}
          </span>
          <button style={btnStyle(false, safePage>=totalPages-1)} disabled={safePage>=totalPages-1} onClick={()=>onPage(safePage+1)}>⟩</button>
          <button style={btnStyle(false, safePage>=totalPages-1)} disabled={safePage>=totalPages-1} onClick={()=>onPage(totalPages-1)}>⟩⟩</button>
        </div>
      )}
    </div>
  );
}

// ─── TxDetailModal ────────────────────────────────────────────────────────────
function TxDetailModal({ tx, inventory, onClose, onEdit, onUndo, fmt, pct, pillCls, salePillCls, toTitleCase, partnerFilters, activeProfiles, setDetailCard }) {
  const venmo = tx.venmoAmount || 0;
  const zelle = tx.zelleAmount || 0;
  const cardsCostBasis = tx.cardsOut.reduce((s,co)=>{ const inv=inventory.find(x=>x.id===co.id); return s+(inv?inv.buyPrice:0); }, 0);
  const totalPaidOut   = tx.cashOut + Math.max(0,-venmo) + Math.max(0,-zelle);
  const costBasis      = cardsCostBasis + totalPaidOut;
  const netRevenue     = (tx.cashIn + Math.max(0,venmo) + Math.max(0,zelle)) - (tx.cashOut + Math.max(0,-venmo) + Math.max(0,-zelle));
  const txProfit       = tx.marketProfit != null ? tx.marketProfit : (() => {
    const flowIn  = tx.cashIn  + Math.max(0,venmo)  + Math.max(0,zelle);
    const flowOut = tx.cashOut + Math.max(0,-venmo) + Math.max(0,-zelle);
    const tradeIn = (tx.cardsIn||[]).reduce((s,ci)=>s+(parseFloat(ci.currentMarket)||parseFloat(ci.marketAtPurchase)||0),0);
    const basis   = tx.cardsOut.reduce((s,co)=>{ const inv=inventory.find(x=>x.id===co.id); return s+(inv?inv.buyPrice:0); },0);
    return (flowIn + tradeIn) - (basis + flowOut);
  })();
  const txTypeLabel = tx.type==="sale"?"SALE":tx.type==="trade"?"TRADE":"BUY";
  const txTagBg     = tx.type==="sale"?"#14532d44":tx.type==="trade"?"#43140744":"#0c4a6e44";
  const txTagColor  = tx.type==="sale"?"#4ade80":tx.type==="trade"?"#fb923c":"#38bdf8";

  return (
    <ModalShell title={`TRANSACTION #${tx.id}`} onClose={onClose}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>

        {/* Header row */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span className="tag" style={{background:txTagBg,color:txTagColor}}>{txTypeLabel}</span>
            <span style={{fontSize:13,color:"#aaa"}}>{tx.date}</span>
            {tx.notes&&<span style={{fontSize:11,color:"#888",background:"#1a1a10",border:"1px solid #2a2a18",borderRadius:3,padding:"2px 8px"}}>📍 {tx.notes}</span>}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="edit-btn" onClick={()=>{ onClose(); onEdit(tx); }}>✎ Edit</button>
            <button className="edit-btn" style={{borderColor:"#7f1d1d44",color:"#b91c1c"}} onClick={()=>{ onClose(); onUndo(tx.id); }}>↩ Undo</button>
          </div>
        </div>

        {/* Financials */}
        <div className="grid2">
          {[
            {label:"Net Revenue", val:<span style={{color:netRevenue>=0?"#f5a623":"#f87171",fontWeight:700,fontSize:16}}>{netRevenue>=0?"+":"-"}{fmt(netRevenue)}</span>},
            {label:"Mkt Profit",  val:<span className={txProfit>=0?"profit":"loss"} style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:18}}>{txProfit>=0?"+":"-"}{fmt(txProfit)}</span>},
            {label:"Cost Basis",  val:<span style={{color:"#666"}}>{fmt(costBasis)}</span>},
          ].map(s=>(
            <div key={s.label}>
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.val}</div>
            </div>
          ))}
        </div>

        {/* Payment methods */}
        {(tx.cashIn>0.005||tx.cashOut>0.005||venmo||zelle) && (
          <div style={{display:"flex",gap:10,flexWrap:"wrap",padding:"10px 12px",background:"#0a0a14",borderRadius:3,border:"1px solid #1a1a28"}}>
            {tx.cashIn>0.005  && <span className="profit">+{fmt(tx.cashIn)} 💵</span>}
            {tx.cashOut>0.005 && <span className="loss">-{fmt(tx.cashOut)} 💵</span>}
            {venmo>0.005      && <span style={{color:"#60a5fa"}}>+{fmt(venmo)} 💙</span>}
            {venmo<-0.005     && <span style={{color:"#f87171"}}>-{fmt(Math.abs(venmo))} 💙</span>}
            {zelle>0.005      && <span style={{color:"#c084fc"}}>+{fmt(zelle)} 💜</span>}
            {zelle<-0.005     && <span style={{color:"#f87171"}}>-{fmt(Math.abs(zelle))} 💜</span>}
          </div>
        )}

        {/* Cards Out */}
        {tx.cardsOut.length>0 && (
          <div>
            <div style={{fontSize:9,color:"#f87171",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8}}>Cards Out</div>
            {tx.cardsOut.map((co,i)=>{
              const card = inventory.find(c=>c.id===co.id);
              const ip   = card&&card.marketAtPurchase>0?(card.buyPrice/card.marketAtPurchase)*100:null;
              const sp   = co.salePrice!=null&&co.currentMarket>0?(co.salePrice/co.currentMarket)*100:null;
              return (
                <div key={i} className="prev-row" style={{flexWrap:"wrap",gap:"3px 8px",marginBottom:6}}>
                  <span style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{color:"#e8e4d9",fontWeight:700,fontSize:13,cursor:card?"pointer":"default"}}
                      onClick={()=>card&&(onClose(),setDetailCard(card))}>{toTitleCase(co.name)}</span>
                    {co.grade&&<span style={{fontSize:10,color:"#a78bfa"}}>{co.grade}</span>}
                    {co.owners?.length>0&&co.owners.map(o=>(
                      <span key={o.profileId} style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                        background:o.color+"22",color:o.color,border:`1px solid ${o.color}44`,fontFamily:"'Space Mono',monospace"}}>
                        {o.initials||o.name.slice(0,2).toUpperCase()} {o.percentage}%
                      </span>
                    ))}
                  </span>
                  <span style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`}>in {pct(ip)}</span>}
                    {card?.buyPrice>0&&<span style={{color:"#666",fontSize:10}}>bought {fmt(card.buyPrice)}</span>}
                    <span style={{color:"#555"}}>mkt {fmt(co.currentMarket||0)}</span>
                    {co.salePrice!=null&&<span style={{color:"#e8e4d9",fontWeight:700}}>→ {fmt(co.salePrice)}</span>}
                    {sp!=null&&<span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Cards In */}
        {tx.cardsIn.length>0 && (
          <div>
            <div style={{fontSize:9,color:"#4ade80",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8}}>Cards In</div>
            {tx.cardsIn.map((ci,i)=>{
              const card  = inventory.find(c=>c.transactionId===tx.id&&(c.name||'').toLowerCase()===(ci.name||'').toLowerCase());
              const ip    = parseFloat(ci.marketAtPurchase)>0?(parseFloat(ci.buyPrice)/parseFloat(ci.marketAtPurchase))*100:null;
              const owners= card?.owners||[];
              return (
                <div key={i} className="prev-row" style={{flexWrap:"wrap",gap:"3px 8px",marginBottom:6}}>
                  <span style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{color:"#e8e4d9",fontWeight:700,fontSize:13,cursor:card?"pointer":"default"}}
                      onClick={()=>card&&(onClose(),setDetailCard(card))}>{toTitleCase(ci.name)}</span>
                    {ci.isGraded&&ci.grade&&<span style={{fontSize:10,color:"#a78bfa"}}>{ci.grade}</span>}
                    {owners.length>0&&owners.map(o=>(
                      <span key={o.profileId} style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                        background:o.color+"22",color:o.color,border:`1px solid ${o.color}44`,fontFamily:"'Space Mono',monospace"}}>
                        {o.initials||o.name.slice(0,2).toUpperCase()} {o.percentage}%
                      </span>
                    ))}
                  </span>
                  <span style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{color:"#555"}}>mkt {fmt(parseFloat(ci.currentMarket)||parseFloat(ci.marketAtPurchase)||0)}</span>
                    {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`}>in {pct(ip)}</span>}
                    {parseFloat(ci.buyPrice)>0&&<span style={{color:"#666",fontSize:10}}>bought {fmt(parseFloat(ci.buyPrice))}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Transaction image */}
        {tx.imageUrl && (
          <div>
            <div style={{fontSize:9,color:"#555",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>Photo</div>
            <SecureImage src={tx.imageUrl} alt="transaction"
              style={{width:"100%",borderRadius:4,border:"1px solid #252535",cursor:"pointer"}}
              onClick={(url)=>window.open(url,'_blank')}/>
          </div>
        )}

        {/* Partner share */}
        {activeProfiles.length>0 && (()=>{
          const partnerCardsOut = tx.cardsOut.map(co=>{
            const inv = inventory.find(c=>c.id===co.id);
            const p   = activeProfiles.reduce((s,pr)=>s+(inv?.owners?.find(o=>o.profileId===pr.id)?.percentage||0)/100,0);
            return {...co, pct:p, buyPrice:inv?.buyPrice||0};
          }).filter(co=>co.pct>0);
          if (!partnerCardsOut.length) return null;
          const partnerRev    = partnerCardsOut.reduce((s,co)=>s+(co.salePrice||0)*co.pct,0);
          const partnerCost   = partnerCardsOut.reduce((s,co)=>s+co.buyPrice*co.pct,0);
          const partnerProfit = partnerRev - partnerCost;
          return (
            <div style={{padding:"10px 12px",background:"#0a0a14",border:"1px solid #1e1e30",borderRadius:3,
              display:"flex",gap:14,flexWrap:"wrap",alignItems:"center"}}>
              <div style={{display:"flex",gap:4}}>
                {activeProfiles.map(p=><div key={p.id} style={{width:6,height:6,borderRadius:"50%",background:p.color}}/>)}
              </div>
              <span style={{fontSize:9,color:"#aaa",letterSpacing:1.5,textTransform:"uppercase",fontWeight:700}}>
                {activeProfiles.map(p=>p.name).join(" + ")}'s Share
              </span>
              <span style={{fontSize:11,color:"#aaa"}}>rev <span style={{color:"#4ade80",fontWeight:700}}>{fmt(partnerRev)}</span></span>
              <span style={{fontSize:11,color:"#aaa"}}>cost <span style={{color:"#f87171",fontWeight:700}}>{fmt(partnerCost)}</span></span>
              <span style={{fontSize:11,color:"#aaa"}}>profit <span className={partnerProfit>=0?"profit":"loss"} style={{fontWeight:700}}>{partnerProfit>=0?"+":"-"}{fmt(Math.abs(partnerProfit))}</span></span>
            </div>
          );
        })()}
      </div>
    </ModalShell>
  );
}

// ─── CardDetailModal ──────────────────────────────────────────────────────────
function CardDetailModal({ card, transactions, inventory, onClose, reload, fmt, pct, pillCls, salePillCls, toTitleCase, GradeTag }) {
  const [cardImgUrl, setCardImgUrl] = useState(card.imageUrl || '');
  const [imgSaving,  setImgSaving]  = useState(false);

  const inTx  = card.transactionId ? transactions.find(t => t.id === card.transactionId) : null;
  const outTx = transactions.find(t => t.cardsOut.some(co => co.id === card.id));
  const relTx = [...new Map([inTx, outTx].filter(Boolean).map(t => [t.id, t])).values()];

  async function saveCardImage(url) {
    setCardImgUrl(url);
    setImgSaving(true);
    try {
      await api(`/api/cards/${card.id}/image`, { method:'PATCH', body:{ imageUrl: url || null } });
      await reload();
    } catch(e) { alert('Image save failed: ' + e.message); }
    finally { setImgSaving(false); }
  }

  return (
    <ModalShell title="CARD DETAILS" onClose={onClose}>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
          <div>
            <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:22,color:"#e8e4d9",letterSpacing:1}}>
              {toTitleCase(card.name)}
            </div>
            <div style={{marginTop:4}}><GradeTag card={card}/></div>
          </div>
          <span className="tag" style={{background:card.status==="in_stock"?"#14532d44":"#43140744",
            color:card.status==="in_stock"?"#4ade80":"#fb923c",alignSelf:"flex-start"}}>
            {card.status.replace("_"," ").toUpperCase()}
          </span>
        </div>

        {/* Card image */}
        {(cardImgUrl || card.status === 'in_stock') && (
          <div>
            <ImagePicker value={cardImgUrl} onChange={saveCardImage}
              label={imgSaving ? "Saving…" : (cardImgUrl ? "Card Photo" : "Add Card Photo (optional)")}/>
          </div>
        )}

        {/* Ownership chips */}
        {card.owners?.length>0 && (
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {card.owners.map(o=>(
              <span key={o.profileId} style={{fontSize:10,padding:"2px 8px",borderRadius:3,
                background:o.color+"22",color:o.color,border:`1px solid ${o.color}55`,
                fontFamily:"'Space Mono',monospace"}}>
                {o.name} · {o.percentage}%
              </span>
            ))}
          </div>
        )}

        {/* Stats */}
        <div className="grid2">
          {[
            {label:"Buy Price",      val:fmt(card.buyPrice)},
            {label:"Mkt @ Purchase", val:card.marketAtPurchase?fmt(card.marketAtPurchase):"—"},
            {label:"Current Market", val:fmt(card.currentMarket||0)},
            {label:"Unrealized",     val:(()=>{const g=(card.currentMarket||0)-card.buyPrice;return <span className={g>=0?"profit":"loss"} style={{fontWeight:700}}>{g>=0?"+":"-"}{fmt(g)}</span>;})()},
          ].map(s=>(
            <div key={s.label}>
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{fontSize:18}}>{s.val}</div>
            </div>
          ))}
        </div>
        {card.marketAtPurchase>0&&(
          <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:11,color:"#555"}}>Intake %:</span>
            <span className={`pct-pill ${pillCls((card.buyPrice/card.marketAtPurchase)*100)}`} style={{fontSize:12}}>
              {pct((card.buyPrice/card.marketAtPurchase)*100)}
            </span>
          </div>
        )}

        {/* Transaction history */}
        {relTx.length>0 && (
          <div>
            <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:8}}>Transaction History</div>
            {relTx.map(tx=>{
              const co   = tx.cardsOut.find(c=>c.id===card.id);
              const typeLabel = tx.type==="sale"?"Sale":tx.type==="trade"?"Trade":"Purchase";
              const accent = tx.type==="buy"?"#38bdf8":tx.type==="sale"?"#4ade80":"#fb923c";
              const venmo=tx.venmoAmount||0, zelle=tx.zelleAmount||0;
              const otherOut=tx.cardsOut.filter(c=>c.id!==card.id);
              const isIncoming = tx===inTx && tx.type!=="buy";
              return (
                <div key={tx.id} style={{padding:12,borderRadius:4,border:`1px solid ${accent}33`,
                  background:"#0e0e18",marginBottom:8,borderLeft:`3px solid ${accent}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:4,marginBottom:6}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <span className="tag" style={{background:accent+"22",color:accent,fontSize:10}}>{typeLabel}</span>
                      <span style={{fontSize:11,color:"#aaa"}}>{tx.date}</span>
                      {tx.notes&&<span style={{fontSize:10,color:"#666"}}>📍 {tx.notes}</span>}
                    </div>
                    <span style={{fontSize:9,color:"#333"}}>#{tx.id}</span>
                  </div>
                  {tx.type==="buy"&&<div style={{fontSize:11,color:"#aaa"}}>
                    Bought for <span style={{color:"#f87171",fontWeight:700}}>{fmt(card.buyPrice)}</span>
                    {card.marketAtPurchase>0&&<span style={{color:"#555"}}> · mkt {fmt(card.marketAtPurchase)}</span>}
                  </div>}
                  {isIncoming&&<div style={{fontSize:11,color:"#aaa"}}>
                    Received in trade · cost <span style={{color:"#f87171",fontWeight:700}}>{fmt(card.buyPrice)}</span>
                  </div>}
                  {co&&<div style={{fontSize:11,color:"#aaa",marginTop:4}}>
                    {typeLabel} at <span style={{color:"#4ade80",fontWeight:700}}>{fmt(co.salePrice)}</span>
                    {card.buyPrice!=null&&co.salePrice!=null&&<> · profit <span className={(co.salePrice-card.buyPrice)>=0?"profit":"loss"} style={{fontWeight:700}}>
                      {(co.salePrice-card.buyPrice)>=0?"+":"-"}{fmt(Math.abs(co.salePrice-card.buyPrice))}
                    </span></>}
                  </div>}
                  {(otherOut.length>0||(!isIncoming&&tx.cardsIn.length>0))&&(
                    <div style={{marginTop:6,fontSize:10,color:"#555"}}>
                      {otherOut.length>0&&<span>Also out: {otherOut.map(c=>toTitleCase(c.name)).join(", ")}</span>}
                      {!isIncoming&&tx.cardsIn.length>0&&<span>{otherOut.length>0?" · ":""}Also in: {tx.cardsIn.map(c=>toTitleCase(c.name)).join(", ")}</span>}
                    </div>
                  )}
                  <div style={{marginTop:6,display:"flex",gap:8,flexWrap:"wrap",fontSize:10}}>
                    {tx.cashIn>0.005&&<span style={{color:"#86efac"}}>+{fmt(tx.cashIn)} 💵</span>}
                    {tx.cashOut>0.005&&<span style={{color:"#f87171"}}>-{fmt(tx.cashOut)} 💵</span>}
                    {venmo>0.005&&<span style={{color:"#60a5fa"}}>+{fmt(venmo)} 💙</span>}
                    {venmo<-0.005&&<span style={{color:"#f87171"}}>-{fmt(Math.abs(venmo))} 💙</span>}
                    {zelle>0.005&&<span style={{color:"#c084fc"}}>+{fmt(zelle)} 💜</span>}
                    {zelle<-0.005&&<span style={{color:"#f87171"}}>-{fmt(Math.abs(zelle))} 💜</span>}
                  </div>
                  {tx.imageUrl&&<SecureImage src={tx.imageUrl} alt="tx" style={{width:"100%",maxHeight:90,objectFit:"cover",borderRadius:3,marginTop:8,border:"1px solid #252535",cursor:"pointer"}} onClick={(url)=>window.open(url,'_blank')}/>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

export default function App() {
  // ── Remote data ──────────────────────────────────────────────────────────────
  const [inventory,    setInventory]    = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [profiles,     setProfiles]     = useState([]);
  const [equityDefaults, setEquityDefaults] = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);

  // Backup state
  const [lastBackup,    setLastBackup]    = useState(null);
  const [backupWorking, setBackupWorking] = useState(false);
  const [backupInfo,    setBackupInfo]    = useState(null);

  // Storage mode
  const [storageMode,   setStorageMode]   = useState(null);

  async function fetchBackupStatus() {
    try {
      const d = await api('/api/backup/status');
      setLastBackup(d.lastBackup);
      setBackupInfo({ uploadsMB: d.uploadsMB, uploadsZipMB: d.uploadsZipMB, dbCount: d.dbCount });
    } catch {}
  }

  async function handleBackup() {
    setBackupWorking(true);
    try {
      const d = await api('/api/backup/now', { method: 'POST' });
      setLastBackup(d.lastBackup);
      await fetchBackupStatus();
      window.location.href = '/api/backup/download/db';
    } catch(e) {
      alert('Backup failed: ' + e.message);
    } finally {
      setBackupWorking(false);
    }
  }

  async function reload() {
    try {
      const [cards, txs, profs, eqDef, settings] = await Promise.all([
        api('/api/cards'), api('/api/transactions'), api('/api/profiles'),
        api('/api/equity-defaults'), api('/api/settings'),
      ]);
      setInventory(cards);
      setTransactions(txs);
      setProfiles(profs);
      setEquityDefaults(eqDef.owners || []);
      if (settings.defaultNote !== undefined) setDefaultNote(settings.defaultNote || '');
    } catch(e) { setError(e.message); }
  }

  async function saveDefaultNote(val) {
    setDefaultNote(val);
    try {
      await api('/api/settings/defaultNote', { method:'PUT', body:{ value: val } });
    } catch(e) { console.error('Failed to save default note', e); }
  }

  useEffect(() => {
    reload().then(() => setLoading(false));
    fetchBackupStatus();
    fetch('/api/storage-mode').then(r=>r.json()).then(setStorageMode).catch(()=>{});
  }, []);

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [view,        setView]        = useState("in_stock");
  const [defaultNote, setDefaultNote] = useState("");
  const [editingDN,   setEditingDN]   = useState(false);

  // ── Pagination state ──────────────────────────────────────────────────────────
  const [stockPage,   setStockPage]   = useState(0);
  const [stockPP,     setStockPP]     = useState(50);
  const [soldPage,    setSoldPage]    = useState(0);
  const [soldPP,      setSoldPP]      = useState(50);
  const [txPage,      setTxPage]      = useState(0);
  const [txPP,        setTxPP]        = useState(20);
  const [tempDN,      setTempDN]      = useState("");

  // Modals
  const [showAddCard,   setShowAddCard]   = useState(false);
  const [showAddTx,     setShowAddTx]     = useState(false);
  const [showBatch,     setShowBatch]     = useState(false);
  const [showProfiles,  setShowProfiles]  = useState(false);
  const [txType,        setTxType]        = useState("sale");
  const [editTx,        setEditTx]        = useState(null);
  const [editCard,      setEditCard]      = useState(null);
  const [editCardOwners, setEditCardOwners] = useState([]);
  const [editSold,      setEditSold]      = useState(null);
  const [detailCard,    setDetailCard]    = useState(null);
  const [detailTx,      setDetailTx]      = useState(null);

  // Profiles management state
  const [profileDraft,    setProfileDraft]    = useState({ name:"", color:"#f5a623", initials:"" });
  const [editingProfile,  setEditingProfile]  = useState(null); // profile object being edited

  // Add card form — ownership
  const [addCardOwners,  setAddCardOwners]  = useState([]);
  const [addCardPayment, setAddCardPayment] = useState({ methods:["cash"], cashAmt:"", cashDir:"out", venmoAmt:"", venmoDir:"out", zelleAmt:"", zelleDir:"out" });

  // Batch payment
  const [batchPayment, setBatchPayment] = useState({ methods:["cash"], cashAmt:"", cashDir:"out", venmoAmt:"", venmoDir:"out", zelleAmt:"", zelleDir:"out" });

  // Add card form
  const [newCard,       setNewCard]       = useState(BLANK_CARD);
  const [addCardDate,   setAddCardDate]   = useState(new Date().toISOString().split("T")[0]);
  const [addCardNotes,  setAddCardNotes]  = useState("");
  const [addCardImage,  setAddCardImage]  = useState("");

  // Transaction form
  const [txDate,       setTxDate]       = useState(new Date().toISOString().split("T")[0]);
  const [txNotes,      setTxNotes]      = useState("");
  const [txCashAmt,    setTxCashAmt]    = useState("");
  const [txCashDir,    setTxCashDir]    = useState("in");
  const [txPaymentMethods, setTxPaymentMethods] = useState(["cash"]);
  const [txVenmoAmount,    setTxVenmoAmount]    = useState("");
  const [txZelleAmount,    setTxZelleAmount]    = useState("");
  const [txVenmoDir,       setTxVenmoDir]       = useState("in");
  const [txZelleDir,       setTxZelleDir]       = useState("in");
  const [txCardsOut,   setTxCardsOut]   = useState([]);
  const [txCardsIn,    setTxCardsIn]    = useState([]);
  const [txImageUrl,   setTxImageUrl]   = useState("");
  const [txCardSearch, setTxCardSearch] = useState("");
  const [txFinalPrice,   setTxFinalPrice]   = useState(""); // pro-rata for cards out
  const [txInFinalPrice, setTxInFinalPrice] = useState(""); // pro-rata for cards in (trade)
  const [newTradeCard, setNewTradeCard] = useState(BLANK_CARD);
  // Ownership for cards coming IN via trade (applied to each trade-in card)
  const [txInOwners,   setTxInOwners]   = useState([]);

  // Batch purchase
  const [batchDate,          setBatchDate]          = useState(new Date().toISOString().split("T")[0]);
  const [batchNotes,         setBatchNotes]         = useState("");
  const [batchCards,         setBatchCards]         = useState([]);
  const [batchDraft,         setBatchDraft]         = useState(BLANK_CARD);
  const [batchDraftQty,      setBatchDraftQty]      = useState("1");
  const [batchFinalPurchase, setBatchFinalPurchase] = useState("");
  const [batchImage,         setBatchImage]         = useState("");
  const [batchOwners,        setBatchOwners]        = useState([]);

  // Filters
  const [soldPeriod,      setSoldPeriod]      = useState(() => new Date().toISOString().slice(0,7));
  const [soldSearch,      setSoldSearch]      = useState("");
  const [partnerFilters, setPartnerFilters] = useState([]); // empty=all, else array of profile ids
  const [txFilterMode,    setTxFilterMode]    = useState("day");
  const [txDateFilter,    setTxDateFilter]    = useState(() => new Date().toISOString().split("T")[0]);
  const [editingMarket,   setEditingMarket]   = useState(null);
  const [tempMarket,      setTempMarket]      = useState("");
  const [inventorySearch, setInventorySearch] = useState("");

  // Reset pages when filters/searches change
  useEffect(() => { setStockPage(0); }, [inventorySearch, partnerFilters]);
  useEffect(() => { setSoldPage(0);  }, [soldSearch, soldPeriod, partnerFilters]);
  useEffect(() => { setTxPage(0);    }, [txFilterMode, txDateFilter, partnerFilters]);

  // ── Derived ───────────────────────────────────────────────────────────────────
  const inStockCards = inventory.filter(c => c.status === "in_stock");
  const soldCards    = inventory.filter(c => c.status === "sold" || c.status === "traded");
  const soldMonths   = [...new Set(
    transactions.filter(t => soldCards.some(c => c.transactionId === t.id))
                .map(t => t.date.slice(0,7))
  )].sort((a,b) => b.localeCompare(a));

  const filteredSoldCards = useMemo(() => {
    if (soldPeriod === "all") return soldCards;
    return soldCards.filter(c => {
      const tx = transactions.find(t => t.id === c.transactionId);
      return tx && tx.date.slice(0,7) === soldPeriod;
    });
  }, [soldCards, transactions, soldPeriod]);

  // ── Partner helpers ───────────────────────────────────────────────────────────
  // Returns fraction (0-1) that profileId owns of a card; 1 if no filter active, 0 if not owner
  // partnerFilters = [] means "all"; otherwise shows combined share of selected profiles
  const activeProfiles = partnerFilters.length
    ? profiles.filter(p => partnerFilters.includes(p.id))
    : [];

  // Returns stored equity defaults if valid, otherwise even split across active profiles
  const getDefaultOwners = () => {
    const active = profiles.filter(p => !p.archived);
    if (!active.length) return [];
    // Validate stored defaults: all profileIds still exist and active, percentages sum to ~100
    if (equityDefaults.length > 0) {
      const valid = equityDefaults.filter(o => active.some(p => p.id === o.profileId));
      const total = valid.reduce((s, o) => s + (o.percentage || 0), 0);
      if (valid.length > 0 && Math.abs(total - 100) < 0.5) {
        // Re-attach current name/color/initials in case profile was edited
        return valid.map(o => {
          const p = active.find(p => p.id === o.profileId);
          return { ...o, name: p.name, color: p.color, initials: p.initials };
        });
      }
    }
    return defaultOwners(active);
  };

  // Returns combined fraction that selected profiles own of a card (1.0 if no filter active)
  const ownerPct = (card, filters) => {
    const f = filters ?? partnerFilters;
    if (!f.length) return 1;
    if (!card.owners?.length) return 0;
    return card.owners
      .filter(o => f.includes(o.profileId))
      .reduce((s, o) => s + o.percentage / 100, 0);
  };

  const visibleInStockCards = useMemo(() => {
    let cards = partnerFilters.length
      ? inStockCards.filter(c => c.owners?.some(o => partnerFilters.includes(o.profileId)))
      : inStockCards;
    if (!inventorySearch.trim()) return cards;
    const term = inventorySearch.toLowerCase();
    return cards.filter(c =>
      (c.name || "").toLowerCase().includes(term) ||
      (c.grade || "").toLowerCase().includes(term) ||
      (c.condition || "").toLowerCase().includes(term)
    );
  }, [inStockCards, inventorySearch, partnerFilters]);

  const stats = useMemo(() => {
    const pf = partnerFilters;
    const getPct = c => ownerPct(c, pf);
    const relevantSold = pf.length
      ? soldCards.filter(c => c.owners?.some(o => pf.includes(o.profileId)))
      : soldCards;
    const mktVal         = visibleInStockCards.reduce((s,c) => s+(c.currentMarket||0)*getPct(c), 0);
    const revenue        = relevantSold.reduce((s,c) => s+(c.salePrice||0)*getPct(c), 0);
    const costOfSold     = relevantSold.reduce((s,c) => s+c.buyPrice*getPct(c), 0);
    const profit         = revenue - costOfSold;
    const valid          = visibleInStockCards.filter(c => c.marketAtPurchase > 0);
    const avgIntake      = valid.length ? valid.reduce((s,c) => s+(c.buyPrice/c.marketAtPurchase)*100,0)/valid.length : 0;
    const periodFiltered = pf.length
      ? filteredSoldCards.filter(c => c.owners?.some(o => pf.includes(o.profileId)))
      : filteredSoldCards;
    const periodRevenue  = periodFiltered.reduce((s,c) => s+(c.salePrice||0)*getPct(c), 0);
    const periodCost     = periodFiltered.reduce((s,c) => s+c.buyPrice*getPct(c), 0);
    const periodProfit   = periodRevenue - periodCost;
    return { mktVal, revenue, costOfSold, profit, avgIntake, periodRevenue, periodCost, periodProfit };
  }, [inventory, inStockCards, visibleInStockCards, soldCards, filteredSoldCards, partnerFilters, profiles]);

  // Derived cash in/out from unified cash field
  const txCashIn  = txCashDir==="in"  ? txCashAmt : "";
  const txCashOut = txCashDir==="out" ? txCashAmt : "";
  const cashInVal     = toF(txCashAmt) * (txCashDir==="in" ? 1 : 0);
  const totalMktOut   = txCardsOut.reduce((s,c) => s+(c.currentMarket||0), 0);
  const totalMktIn    = txCardsIn.reduce((s,c) => s+(toF(c.tradedAtPrice)||toF(c.currentMarket)||toF(c.marketAtPurchase)||0), 0);
  const cardsSaleSum  = txCardsOut.reduce((s,c) => s+(toF(c.tradedAtPrice)||0), 0);
  const autoSaleTotal = txType === "sale"
    ? (toF(txFinalPrice) > 0 ? toF(txFinalPrice) : cardsSaleSum) : 0;

  // ── Card mutations ────────────────────────────────────────────────────────────
  async function handleAddCard(e) {
    e.preventDefault();
    const normalized = {
      name:             newCard.name,
      isGraded:         newCard.isGraded,
      gradingCompany:   newCard.isGraded ? newCard.gradingCompany : null,
      grade:            newCard.isGraded ? newCard.grade : null,
      condition:        newCard.isGraded ? null : newCard.condition,
      buyPrice:         toF(newCard.buyPrice),
      marketAtPurchase: toF(newCard.marketAtPurchase),
      currentMarket:    newCard.currentMarketTouched ? toF(newCard.currentMarket) : toF(newCard.marketAtPurchase),
      owners:           addCardOwners,
    };
    const notes        = addCardNotes.trim() || defaultNote;
    const pm           = addCardPayment;
    // Compute auto-split: empty fields share the remaining balance evenly
    const totalBuy     = normalized.buyPrice;
    const amtKey       = { cash:"cashAmt", venmo:"venmoAmt", zelle:"zelleAmt" };
    const filledSum    = pm.methods.reduce((s,m) => s + (parseFloat(pm[amtKey[m]])||0), 0);
    const emptyCount   = pm.methods.filter(m => !pm[amtKey[m]]).length;
    const autoSplit    = emptyCount > 0 ? Math.max(0, totalBuy - filledSum) / emptyCount : 0;
    const resolve = m => pm.methods.includes(m) ? (parseFloat(pm[amtKey[m]]) || autoSplit) : 0;
    const cashRaw  = resolve("cash");
    const venmoRaw = resolve("venmo");
    const zelleRaw = resolve("zelle");
    const venmoSigned  = pm.methods.includes("venmo") ? (pm.venmoDir==="in" ?  venmoRaw : -venmoRaw) : null;
    const zelleSigned  = pm.methods.includes("zelle") ? (pm.zelleDir==="in" ?  zelleRaw : -zelleRaw) : null;
    const hasCash      = pm.methods.includes("cash");
    const cashOut      = hasCash ? (pm.cashDir==="out" ? cashRaw : 0) : 0;
    const cashIn       = hasCash ? (pm.cashDir==="in"  ? cashRaw : 0) : 0;
    const mktIn        = normalized.currentMarket || normalized.marketAtPurchase || 0;
    const totalOut     = cashOut + Math.max(0,-(venmoSigned||0)) + Math.max(0,-(zelleSigned||0));
    const marketProfit = mktIn - totalOut;

    await api('/api/transactions', { method:'POST', body:{
      type:'buy', date:addCardDate, notes, imageUrl:addCardImage || null,
      cashIn, cashOut, marketProfit, cardsOut:[], cardsIn:[normalized],
      paymentMethod: pm.methods.join(',') || null,
      venmoAmount: venmoSigned, zelleAmount: zelleSigned,
    }});
    setNewCard(BLANK_CARD);
    setAddCardDate(new Date().toISOString().split("T")[0]);
    setAddCardNotes("");
    setAddCardImage("");
    setAddCardOwners([]);
    setAddCardPayment({ methods:["cash"], cashAmt:"", cashDir:"out", venmoAmt:"", venmoDir:"out", zelleAmt:"", zelleDir:"out" });
    setShowAddCard(false);
    await reload();
  }

  async function handleDeleteCard(id) {
    if (!window.confirm("Delete this card from inventory? This cannot be undone.")) return;
    await api(`/api/cards/${id}`, { method:'DELETE' });
    await reload();
  }

  async function saveMarket(id) {
    const v = parseFloat(tempMarket);
    if (!isNaN(v) && v > 0) {
      await api(`/api/cards/${id}/market`, { method:'PATCH', body:{ currentMarket:v } });
      await reload();
    }
    setEditingMarket(null);
  }

  async function handleSaveCard() {
    if (!editCard) return;
    await api(`/api/cards/${editCard.id}`, { method:'PUT', body:{
      name:             editCard.name,
      isGraded:         editCard.isGraded,
      gradingCompany:   editCard.isGraded ? editCard.gradingCompany : null,
      grade:            editCard.isGraded ? editCard.grade : null,
      condition:        editCard.isGraded ? null : editCard.condition,
      buyPrice:         toF(editCard.buyPrice),
      marketAtPurchase: toF(editCard.marketAtPurchase),
      currentMarket:    toF(editCard.currentMarket),
      status:           editCard.status,
      salePrice:        editCard.salePrice,
      owners:           editCardOwners,
    }});
    setEditCard(null);
    setEditCardOwners([]);
    await reload();
  }

  async function handleSaveSold() {
    if (!editSold) return;
    await api(`/api/cards/${editSold.id}`, { method:'PUT', body:{
      name:             editSold.name,
      isGraded:         editSold.isGraded,
      gradingCompany:   editSold.isGraded ? editSold.gradingCompany : null,
      grade:            editSold.isGraded ? editSold.grade : null,
      condition:        editSold.isGraded ? null : editSold.condition,
      buyPrice:         toF(editSold.buyPrice),
      marketAtPurchase: toF(editSold.marketAtPurchase),
      currentMarket:    toF(editSold.currentMarket),
      status:           editSold.status,
      salePrice:        toF(editSold.salePrice),
    }});
    setEditSold(null);
    await reload();
  }

  // ── Batch purchase ────────────────────────────────────────────────────────────
  function handleStageBatchCard() {
    if (!batchDraft.name.trim()) return;
    const qty = Math.max(1, parseInt(batchDraftQty || "1", 10) || 1);
    setBatchCards(p => [...p, {
      ...batchDraft, qty,
      buyPrice:         toF(batchDraft.buyPrice),
      marketAtPurchase: toF(batchDraft.marketAtPurchase),
      currentMarket:    batchDraft.currentMarketTouched ? toF(batchDraft.currentMarket) : toF(batchDraft.marketAtPurchase),
      gradingCompany:   batchDraft.isGraded ? batchDraft.gradingCompany : null,
      grade:            batchDraft.isGraded ? batchDraft.grade : null,
      condition:        batchDraft.isGraded ? null : batchDraft.condition,
    }]);
    setBatchDraft(BLANK_CARD);
    setBatchDraftQty("1");
  }

  async function handleCommitBatch() {
    if (!batchCards.length) return;
    const expandedBase = [];
    for (const c of batchCards) {
      for (let i = 0; i < (c.qty || 1); i++) expandedBase.push({ ...c });
    }
    const totalMarket = expandedBase.reduce((s,c) => s+(c.currentMarket||c.marketAtPurchase||0), 0);
    const finalTotal  = toF(batchFinalPurchase);
    const cardsForTx  = (finalTotal > 0 && totalMarket > 0)
      ? expandedBase.map(c => {
          const m = c.currentMarket || c.marketAtPurchase || 0;
          const { qty, ...rest } = c;
          return { ...rest, buyPrice: finalTotal * (m / totalMarket), owners: batchOwners };
        })
      : expandedBase.map(c => { const { qty, ...rest } = c; return { ...rest, owners: batchOwners }; });

    const pm           = batchPayment;
    // Compute auto-split: empty fields share the remaining balance evenly
    const totalBuy     = cardsForTx.reduce((s,c) => s+(c.buyPrice||0), 0);
    const amtKey       = { cash:"cashAmt", venmo:"venmoAmt", zelle:"zelleAmt" };
    const filledSum    = pm.methods.reduce((s,m) => s + (parseFloat(pm[amtKey[m]])||0), 0);
    const emptyCount   = pm.methods.filter(m => !pm[amtKey[m]]).length;
    const autoSplit    = emptyCount > 0 ? Math.max(0, totalBuy - filledSum) / emptyCount : 0;
    const resolve = m => pm.methods.includes(m) ? (parseFloat(pm[amtKey[m]]) || autoSplit) : 0;
    const cashRaw  = resolve("cash");
    const venmoRaw = resolve("venmo");
    const zelleRaw = resolve("zelle");
    const venmoSigned  = pm.methods.includes("venmo") ? (pm.venmoDir==="in" ?  venmoRaw : -venmoRaw) : null;
    const zelleSigned  = pm.methods.includes("zelle") ? (pm.zelleDir==="in" ?  zelleRaw : -zelleRaw) : null;
    const hasCash      = pm.methods.includes("cash");
    const cashOut      = hasCash ? (pm.cashDir==="out" ? cashRaw : 0) : 0;
    const cashIn       = hasCash ? (pm.cashDir==="in"  ? cashRaw : 0) : 0;
    const mktIn        = cardsForTx.reduce((s,c) => s+(c.currentMarket||c.marketAtPurchase||0), 0);
    const totalOut     = cashOut + Math.max(0,-(venmoSigned||0)) + Math.max(0,-(zelleSigned||0));
    const marketProfit = mktIn - totalOut;
    const notes        = batchNotes.trim() || defaultNote;

    await api('/api/transactions', { method:'POST', body:{
      type:'buy', date:batchDate, notes, imageUrl:batchImage || null,
      cashIn, cashOut, marketProfit, cardsOut:[], cardsIn:cardsForTx,
      paymentMethod: pm.methods.join(',') || null,
      venmoAmount: venmoSigned, zelleAmount: zelleSigned,
    }});
    setBatchCards([]); setBatchDraft(BLANK_CARD); setBatchFinalPurchase(""); setBatchImage(""); setBatchOwners([]);
    setBatchPayment({ methods:["cash"], cashAmt:"", cashDir:"out", venmoAmt:"", venmoDir:"out", zelleAmt:"", zelleDir:"out" });
    setShowBatch(false);
    await reload();
  }

  // ── Transaction mutations ─────────────────────────────────────────────────────
  function toggleCardOut(card) {
    setTxCardsOut(prev => {
      const exists = prev.find(c => c.id === card.id);
      if (exists) return prev.filter(c => c.id !== card.id);
      return [...prev, {
        id:card.id, name:card.name, isGraded:card.isGraded, grade:card.grade,
        currentMarket:card.currentMarket, marketAtPurchase:card.marketAtPurchase,
        buyPrice:card.buyPrice,
        tradedAtPrice:String(card.currentMarket||""),
      }];
    });
  }

  function updateCardOutTradedAt(id, val) {
    setTxCardsOut(prev => prev.map(c => c.id===id ? {...c, tradedAtPrice:val} : c));
  }

  function handleAddTradeCard() {
    if (!newTradeCard.name.trim()) return;
    const mkt = newTradeCard.currentMarketTouched ? toF(newTradeCard.currentMarket) : toF(newTradeCard.marketAtPurchase);
    const agreedPrice = toF(newTradeCard.buyPrice) || mkt;
    setTxCardsIn(prev => [...prev, {
      ...newTradeCard,
      buyPrice:         toF(newTradeCard.buyPrice),
      marketAtPurchase: toF(newTradeCard.marketAtPurchase),
      currentMarket:    mkt,
      tradedAtPrice:    String(agreedPrice || ""),
      gradingCompany:   newTradeCard.isGraded ? newTradeCard.gradingCompany : null,
      grade:            newTradeCard.isGraded ? newTradeCard.grade : null,
      condition:        newTradeCard.isGraded ? null : newTradeCard.condition,
      owners:           txInOwners,
    }]);
    setNewTradeCard(BLANK_CARD);
  }

  async function handleRecordTransaction() {
    if (!txDate || txCardsOut.length === 0) return;
    const notes          = txNotes.trim() || defaultNote;
    const perCardTotal   = txCardsOut.reduce((s,c) => s+(toF(c.tradedAtPrice)||0), 0);
    // For trade: compute raw balance to determine which direction auto should fill
    const myVal          = txType==='trade' ? (toF(txFinalPrice)>0 ? toF(txFinalPrice) : perCardTotal) : 0;
    const theirValBase   = txType==='trade' ? txCardsIn.reduce((s,c)=>s+(toF(c.tradedAtPrice)||toF(c.currentMarket)||toF(c.marketAtPurchase)||0),0) : 0;
    const theirVal       = txType==='trade' && toF(txInFinalPrice)>0 ? toF(txInFinalPrice) : theirValBase;
    const tradeDiff      = myVal - theirVal; // >0 = they owe us, <0 = we owe them
    // refTotal for sale = txFinalPrice or per-card sum
    // refTotal for trade = absolute trade balance (how much cash needs to change hands)
    const saleRef        = txType==='sale' ? (toF(txFinalPrice)>0 ? toF(txFinalPrice) : perCardTotal) : 0;
    const tradeRefAmt    = Math.abs(tradeDiff);
    const tradeRefDir    = tradeDiff > 0 ? "in" : "out"; // if they owe us → we receive; if we owe → we pay
    const hasCash        = txPaymentMethods.includes("cash");
    const hasVenmoSel    = txPaymentMethods.includes("venmo");
    const hasZelleSel    = txPaymentMethods.includes("zelle");
    const cashAmtRaw     = toF(txCashAmt);
    const venmoRaw       = toF(txVenmoAmount);
    const zelleRaw       = toF(txZelleAmount);
    const cashFilled     = txCashAmt !== '';
    const venmoFilled    = txVenmoAmount !== '';
    const zelleFilled    = txZelleAmount !== '';

    // For sale: auto-split across "in" direction empty fields
    // For trade: auto-split across trade balance direction empty fields
    let cashIn=0, cashOut=0, venmoFinal=0, zelleFinal=0;
    if (txType==='sale') {
      const filledIn  = (hasCash&&cashFilled&&txCashDir==="in"?cashAmtRaw:0)
                      + (hasVenmoSel&&venmoFilled&&txVenmoDir==="in"?venmoRaw:0)
                      + (hasZelleSel&&zelleFilled&&txZelleDir==="in"?zelleRaw:0);
      const emptyIn   = [(hasCash&&!cashFilled),(hasVenmoSel&&!venmoFilled&&txVenmoDir==="in"),(hasZelleSel&&!zelleFilled&&txZelleDir==="in")].filter(Boolean).length;
      const autoIn    = emptyIn>0&&saleRef>0 ? Math.max(0,saleRef-filledIn)/emptyIn : 0;
      const resolveIn = (filled, raw, isIn) => filled ? raw : (isIn&&saleRef>0 ? autoIn : 0);
      const cashRes   = hasCash ? resolveIn(cashFilled, cashAmtRaw, txCashDir==="in") : 0;
      cashIn   = hasCash&&txCashDir==="in"  ? cashRes : 0;
      cashOut  = hasCash&&txCashDir==="out" ? (cashFilled?cashAmtRaw:0) : 0;
      venmoFinal = hasVenmoSel ? (txVenmoDir==="in"?(venmoFilled?venmoRaw:autoIn):-(venmoFilled?venmoRaw:0)) : 0;
      zelleFinal = hasZelleSel ? (txZelleDir==="in"?(zelleFilled?zelleRaw:autoIn):-(zelleFilled?zelleRaw:0)) : 0;
    } else if (txType==='trade') {
      // For trade: auto fills based on trade balance direction
      const isPayDir    = (m, dir) => dir === tradeRefDir; // does this field match what needs to happen?
      const cashMatch   = hasCash && txCashDir === tradeRefDir;
      const venmoMatch  = hasVenmoSel && txVenmoDir === tradeRefDir;
      const zelleMatch  = hasZelleSel && txZelleDir === tradeRefDir;
      const filledMatch = (cashMatch&&cashFilled?cashAmtRaw:0)+(venmoMatch&&venmoFilled?venmoRaw:0)+(zelleMatch&&zelleFilled?zelleRaw:0);
      const emptyMatch  = [cashMatch&&!cashFilled,venmoMatch&&!venmoFilled,zelleMatch&&!zelleFilled].filter(Boolean).length;
      const autoMatch   = emptyMatch>0&&tradeRefAmt>0.005 ? Math.max(0,tradeRefAmt-filledMatch)/emptyMatch : 0;
      const cashRes     = hasCash ? (cashFilled ? cashAmtRaw : (cashMatch ? autoMatch : 0)) : 0;
      cashIn   = hasCash&&txCashDir==="in"  ? cashRes : 0;
      cashOut  = hasCash&&txCashDir==="out" ? cashRes : 0;
      const vAmt = hasVenmoSel ? (venmoFilled ? venmoRaw : (venmoMatch ? autoMatch : 0)) : 0;
      const zAmt = hasZelleSel ? (zelleFilled ? zelleRaw : (zelleMatch ? autoMatch : 0)) : 0;
      venmoFinal = hasVenmoSel ? (txVenmoDir==="in" ? vAmt : -vAmt) : 0;
      zelleFinal = hasZelleSel ? (txZelleDir==="in" ? zAmt : -zAmt) : 0;
    } else { // buy
      cashOut  = hasCash&&txCashDir==="out" ? cashAmtRaw : 0;
      cashIn   = hasCash&&txCashDir==="in"  ? cashAmtRaw : 0;
      venmoFinal = hasVenmoSel ? (txVenmoDir==="in" ? venmoRaw : -venmoRaw) : 0;
      zelleFinal = hasZelleSel ? (txZelleDir==="in" ? zelleRaw : -zelleRaw) : 0;
    }

    const totalFlowIn    = cashIn + (venmoFinal>0?venmoFinal:0) + (zelleFinal>0?zelleFinal:0);
    const totalFlowOut   = cashOut + (venmoFinal<0?-venmoFinal:0) + (zelleFinal<0?-zelleFinal:0);
    const totalMkt       = txCardsOut.reduce((s,c) => s+(c.currentMarket||0), 0);
    const hasPerCard     = txCardsOut.some(c => c.tradedAtPrice && toF(c.tradedAtPrice)>0);
    const getSalePrice = card => {
      if (toF(txFinalPrice)>0) return totalMkt>0 ? (card.currentMarket/totalMkt)*toF(txFinalPrice) : 0;
      if (hasPerCard || txType==='trade') return toF(card.tradedAtPrice)||card.currentMarket||0;
      return totalMkt>0 ? (card.currentMarket/totalMkt)*totalFlowIn : 0;
    };
    const costBasis    = txCardsOut.reduce((s,c) => s+(c.buyPrice||0), 0);
    const mktIn        = txCardsIn.reduce((s,c) => s+(toF(c.currentMarket)||toF(c.marketAtPurchase)||0), 0);
    const marketProfit = (totalFlowIn + mktIn) - (costBasis + totalFlowOut);

    await api('/api/transactions', { method:'POST', body:{
      type:txType, date:txDate, notes, cashIn, cashOut, marketProfit, imageUrl:txImageUrl || null,
      paymentMethod: txPaymentMethods.join(',') || null,
      venmoAmount: venmoFinal || null,
      zelleAmount: zelleFinal || null,
      cardsOut: txCardsOut.map(c => ({...c, salePrice:getSalePrice(c)})),
      cardsIn:  txCardsIn,
    }});

    setTxNotes(''); setTxCashAmt(''); setTxCashDir('in'); setTxImageUrl('');
    setTxCardsOut([]); setTxCardsIn([]); setNewTradeCard(BLANK_CARD); setTxCardSearch('');
    setTxPaymentMethods(['cash']); setTxVenmoAmount(''); setTxZelleAmount('');
    setTxVenmoDir('in'); setTxZelleDir('in'); setTxFinalPrice(''); setTxInFinalPrice('');
    setShowAddTx(false);
    await reload();
    setView('transactions');
  }

  // BUG FIX: reset txImageUrl and txCardSearch on every modal open
  function openTxModal(type) {
    setTxType(type);
    setTxDate(new Date().toISOString().split("T")[0]);
    setTxNotes(defaultNote);
    setTxCashAmt(''); setTxCashDir('in'); setTxImageUrl(''); setTxCardSearch('');
    setTxPaymentMethods(['cash']); setTxVenmoAmount(''); setTxZelleAmount('');
    setTxVenmoDir('in'); setTxZelleDir('in'); setTxFinalPrice(''); setTxInFinalPrice('');
    setTxCardsOut([]); setTxCardsIn([]);
    setNewTradeCard(BLANK_CARD);
    setTxInOwners(getDefaultOwners());
    setShowAddTx(true);
  }

  function openEditTx(tx) {
    setEditTx({
      ...tx, cashIn:String(tx.cashIn), cashOut:String(tx.cashOut),
      cardsOut: tx.cardsOut.map(c => ({...c,
        salePrice:     String(c.salePrice ?? ''),
        tradedAtPrice: String(c.salePrice ?? c.currentMarket ?? ''),
      })),
    });
  }

  async function handleSaveTx() {
    if (!editTx) return;
    const cashIn     = toF(editTx.cashIn);
    const cashOut    = toF(editTx.cashOut);
    const updatedOut = editTx.cardsOut.map(c => ({...c, salePrice:toF(c.salePrice)}));
    // Cost basis from inventory (cards going out — what we originally paid)
    const costBasis  = updatedOut.reduce((s,c) => {
      const inv = inventory.find(x => x.id === c.id);
      return s + (inv ? inv.buyPrice : (c.buyPrice||0));
    }, 0);
    const mktIn      = (editTx.cardsIn||[]).reduce((s,c) => s+(toF(c.currentMarket)||toF(c.marketAtPurchase)||0), 0);
    const marketProfit = (cashIn + mktIn) - (costBasis + cashOut);

    await api(`/api/transactions/${editTx.id}`, { method:'PUT', body:{
      date:editTx.date, notes:editTx.notes, cashIn, cashOut, marketProfit,
      cardsOut:updatedOut, imageUrl:editTx.imageUrl || null,
    }});
    setEditTx(null);
    await reload();
  }

  async function handleUndoTransaction(id) {
    if (!window.confirm("Undo this transaction? Cards will be returned to inventory and trade-ins removed.")) return;
    await api(`/api/transactions/${id}/undo`, { method:'POST' });
    await reload();
  }

  // ── Profile handlers ──────────────────────────────────────────────────────────
  async function handleSaveProfile() {
    const name = profileDraft.name.trim();
    if (!name) return;
    const initials = profileDraft.initials.trim() || name.slice(0,2).toUpperCase();
    if (editingProfile) {
      await api(`/api/profiles/${editingProfile.id}`, { method:'PUT', body:{ name, color:profileDraft.color, initials }});
    } else {
      await api('/api/profiles', { method:'POST', body:{ name, color:profileDraft.color, initials }});
    }
    setProfileDraft({ name:"", color:"#f5a623", initials:"" });
    setEditingProfile(null);
    await reload();
  }

  async function handleDeleteProfile(id) {
    if (!window.confirm("Remove this partner? Their ownership records will be cleared from all cards.")) return;
    await api(`/api/profiles/${id}`, { method:'DELETE' });
    await reload();
  }

  async function handleArchiveProfile(id, archive) {
    await api(`/api/profiles/${id}/archive`, { method:'PATCH', body:{ archived: archive }});
    await reload();
  }

  async function handleSaveEquityDefaults(owners) {
    await api('/api/equity-defaults', { method:'PUT', body:{ owners }});
    setEquityDefaults(owners);
  }

  // ── Loading / error screens ───────────────────────────────────────────────────
  if (loading) return (
    <div style={{minHeight:"100vh",background:"#0a0a0f",display:"flex",alignItems:"center",
      justifyContent:"center",color:"#f5a623",fontFamily:"'Space Mono',monospace",fontSize:14,letterSpacing:2}}>
      LOADING CARDLEDGER...
    </div>
  );
  if (error) return (
    <div style={{minHeight:"100vh",background:"#0a0a0f",display:"flex",alignItems:"center",
      justifyContent:"center",color:"#f87171",fontFamily:"'Space Mono',monospace",fontSize:13,
      textAlign:"center",padding:40}}>
      ⚠ Could not connect to server<br/>
      <span style={{color:"#555",fontSize:11,marginTop:8,display:"block"}}>{error}</span><br/>
      <span style={{color:"#555",fontSize:11}}>Make sure the server is running: <code style={{color:"#f5a623"}}>node server/index.js</code></span>
    </div>
  );

  const currentMonthKey = new Date().toISOString().slice(0,7);

  // Helper: live detail card (always fresh from inventory after reload)
  const liveDetailCard = detailCard ? inventory.find(c => c.id === detailCard.id) || detailCard : null;

  return (
    <div style={{minHeight:"100vh",background:"#0a0a0f",color:"#e8e4d9",fontFamily:"'Courier New',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing:border-box; }
        body{margin:0;background:#0a0a0f;overflow-x:hidden}
        ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:#111} ::-webkit-scrollbar-thumb{background:#f5a623;border-radius:3px}
        .nav-btn{background:none;border:none;color:#555;font-family:'Space Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;padding:10px 16px;transition:all 0.2s;border-bottom:2px solid transparent;white-space:nowrap}
        .nav-btn.active{color:#f5a623;border-bottom:2px solid #f5a623}
        .nav-btn:hover:not(.active){color:#aaa}
        .btn{border:none;border-radius:3px;cursor:pointer;font-family:'Space Mono',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:8px 14px;transition:all 0.2s;white-space:nowrap}
        .btn-primary{background:#f5a623;color:#0a0a0f;font-weight:700} .btn-primary:hover{background:#ffc04d}
        .btn-ghost{background:#141420;color:#888;border:1px solid #252535} .btn-ghost:hover{border-color:#f5a623;color:#f5a623}
        .btn-sm{padding:4px 10px;font-size:10px}
        .btn-danger{background:#2a0a0a;color:#f87171;border:1px solid #7f1d1d44} .btn-danger:hover{background:#3d0a0a;border-color:#f87171}
        .btn-export{background:#0d2010;color:#4ade80;border:1px solid #16a34a44} .btn-export:hover{background:#14301a;border-color:#4ade80}
        .input{background:#0a0a0f;border:1px solid #252535;border-radius:3px;color:#e8e4d9;font-family:'Space Mono',monospace;font-size:12px;padding:8px 12px;width:100%}
        .input:focus{outline:none;border-color:#f5a623}
        .input-inline{background:#0a0a0f;border:1px solid #f5a623;border-radius:3px;color:#e8e4d9;font-family:'Space Mono',monospace;font-size:12px;padding:3px 8px;width:90px}
        .select{background:#0a0a0f;border:1px solid #252535;border-radius:3px;color:#e8e4d9;font-family:'Space Mono',monospace;font-size:12px;padding:8px 12px;width:100%;cursor:pointer}
        .select:focus{outline:none;border-color:#f5a623}
        label{display:block;font-size:10px;letter-spacing:1.5px;color:#555;margin-bottom:5px;text-transform:uppercase}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:100;display:flex;align-items:center;justify-content:center;padding:16px}
        .modal{background:#111118;border:1px solid #252535;border-radius:6px;width:100%;max-width:760px;max-height:92vh;overflow-y:auto}
        .profit{color:#4ade80} .loss{color:#f87171}
        .pct-pill{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;font-weight:700}
        .pct-good{background:#14532d44;color:#4ade80} .pct-mid{background:#78350f44;color:#fbbf24} .pct-low{background:#7f1d1d44;color:#f87171}
        .tag{display:inline-block;font-size:9px;letter-spacing:1.5px;padding:2px 7px;border-radius:2px;font-weight:700}
        .stat-card{background:#111118;border:1px solid #1e1e28;border-radius:4px;padding:14px 18px}
        .stat-label{font-size:9px;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:6px}
        .stat-value{font-family:'Black Han Sans',sans-serif;font-size:20px;line-height:1}
        .panel{background:#111118;border:1px solid #1e1e28;border-radius:4px}
        .section-title{font-family:'Black Han Sans',sans-serif;font-size:20px;letter-spacing:2px;color:#f5a623;margin:0}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th{font-size:9px;letter-spacing:1.5px;color:#555;text-transform:uppercase;padding:8px 12px;text-align:left;border-bottom:1px solid #1e1e28;white-space:nowrap}
        td{padding:9px 12px;border-bottom:1px solid #131320;vertical-align:middle}
        tr:last-child td{border-bottom:none}
        tbody tr:hover td{background:#0f0f1c}
        tfoot td{border-top:1px solid #1e1e28;border-bottom:none;font-size:11px;padding:8px 12px}
        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
        .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
        @media(max-width:900px){body{margin:0}.grid4{grid-template-columns:1fr 1fr}.grid3{grid-template-columns:1fr 1fr}.stat-card{padding:10px 12px}}
        @media(max-width:600px){.grid2,.grid3,.grid4{grid-template-columns:1fr}.nav-btn{padding:6px 8px;font-size:9px}.section-title{font-size:17px}table{font-size:11px}th,td{padding:6px 8px}.hide-sm{display:none !important}.hero-logo{font-size:15px}.hero-icon{font-size:18px}.action-row-sm{flex-wrap:nowrap;overflow-x:auto}.btn-sm-wide{padding:6px 10px;font-size:9px}.tx-card{padding:12px}.tx-stats-nums{font-size:13px !important}}
        .tx-card{background:#111118;border:1px solid #1e1e28;border-radius:4px;padding:16px;margin-bottom:8px}
        .tx-sale{border-left:3px solid #4ade80} .tx-trade{border-left:3px solid #fb923c} .tx-buy{border-left:3px solid #38bdf8}
        .cb-card{border:1px solid #1e1e28;border-radius:3px;padding:8px 12px;cursor:pointer;font-size:12px;transition:all 0.15s;display:flex;align-items:center;gap:8px}
        .cb-card.sel{border-color:#f5a623;background:#1a1208} .cb-card:hover:not(.sel){border-color:#333}
        .tx-type-btn{flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid #252535;border-radius:3px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;transition:all 0.2s;font-family:'Space Mono',monospace;background:none;color:#666}
        .tx-type-btn.active{background:#f5a623;color:#0a0a0f;border-color:#f5a623;font-weight:700}
        .prev-row{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:5px 0;border-bottom:1px dashed #1a1a28}
        .prev-row:last-child{border-bottom:none}
        .empty{padding:48px 24px;text-align:center;color:#333;font-size:13px}
        .mkt-edit-btn{background:none;border:none;color:#f5a623;cursor:pointer;font-size:11px;padding:2px 4px;opacity:0;transition:opacity 0.15s}
        tr:hover .mkt-edit-btn{opacity:1}
        .edit-btn{background:none;border:1px solid #252535;color:#555;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:3px;font-family:'Space Mono',monospace;letter-spacing:1px;text-transform:uppercase;transition:all 0.15s}
        .edit-btn:hover{color:#f5a623;border-color:#f5a623}
        .default-note-banner{background:#13130a;border:1px solid #3a3010;border-radius:4px;padding:10px 16px;margin-bottom:18px;display:flex;align-items:center;gap:10px}
        .default-note-active{background:#1a1a08;border-color:#f5a62366}
        .tx-img{width:100%;max-height:120px;object-fit:cover;border-radius:3px;margin-top:8px;border:1px solid #1e1e28;cursor:pointer}
      `}</style>

      {/* HEADER */}
      <div style={{borderBottom:"1px solid #141420"}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"0 20px",display:"flex",alignItems:"center",
          justifyContent:"space-between",height:52,gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <span className="hero-icon" style={{fontSize:20}}>⚡</span>
            <span className="hero-logo" style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:17,letterSpacing:3,color:"#f5a623"}}>CARDLEDGER</span>
          </div>
          <nav style={{display:"flex",overflowX:"auto"}}>
            {[{k:"in_stock",l:`Stock (${inStockCards.length})`},{k:"sold",l:`Sold (${soldCards.length})`},{k:"transactions",l:"Transactions"},{k:"stats",l:"Analytics"}].map(v => (
              <button key={v.k} className={`nav-btn ${view===v.k?"active":""}`} onClick={() => setView(v.k)}>{v.l}</button>
            ))}
            <button className="nav-btn" onClick={() => setShowProfiles(true)} style={{marginLeft:"auto",color:"#f5a623"}}>
              👥 {profiles.length ? `${profiles.length} Partner${profiles.length>1?"s":""}` : "Partners"}
            </button>
          </nav>
          <div className="hide-sm" style={{display:"flex",gap:6,flexShrink:0,alignItems:"center"}}>
            <a href="/api/export/inventory.csv" download><button className="btn btn-export btn-sm" title="Download Inventory CSV">📦 Inv</button></a>
            <a href="/api/export/transactions.csv" download><button className="btn btn-export btn-sm" title="Download Transactions CSV">🧾 Tx</button></a>
            <button
              className="btn btn-export btn-sm"
              onClick={handleBackup}
              disabled={backupWorking}
              title={backupInfo ? `Images folder: ${backupInfo.uploadsMB}MB raw | Uploads zip: ${backupInfo.uploadsZipMB||'none'}MB | DB copies: ${backupInfo.dbCount}` : 'Backup DB + zip images'}
              style={{opacity:backupWorking?0.6:1,whiteSpace:"nowrap"}}>
              {backupWorking ? "⏳ zipping..." : <>
                💾 Backup
                {lastBackup && <span style={{fontSize:8,color:"#888",marginLeft:5}}>
                  {(()=>{
                    const diff = Date.now() - new Date(lastBackup).getTime();
                    const mins = Math.floor(diff/60000);
                    const hrs  = Math.floor(mins/60);
                    const days = Math.floor(hrs/24);
                    if (days>0) return `${days}d ago`;
                    if (hrs>0)  return `${hrs}h ago`;
                    if (mins>0) return `${mins}m ago`;
                    return "just now";
                  })()}
                </span>}
                {backupInfo && <span style={{fontSize:8,color:"#666",marginLeft:4}}>· {backupInfo.uploadsMB}MB</span>}
              </>}
            </button>
          </div>
        </div>
      </div>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"18px 20px"}}>

        {/* S3 WARNING BANNER */}
        {storageMode && !storageMode.useLocal && !storageMode.s3Ready && (
          <div style={{background:"#1a0808",border:"1px solid #7f1d1d",borderRadius:4,padding:"10px 16px",
            marginBottom:18,display:"flex",alignItems:"center",gap:10,color:"#f87171",fontSize:11,fontFamily:"'Space Mono',monospace"}}>
            ⚠️ <span><strong>S3 not connected.</strong> USE_LOCAL_STORAGE=false but S3 failed to initialize. Images cannot be uploaded. Check your .env and restart the server.</span>
          </div>
        )}
        {storageMode && storageMode.useLocal && (
          <div style={{background:"#0a0a18",border:"1px solid #252535",borderRadius:4,padding:"8px 16px",
            marginBottom:18,display:"flex",alignItems:"center",gap:10,color:"#555",fontSize:10,fontFamily:"'Space Mono',monospace"}}>
            💾 Storage: <span style={{color:"#f5a623"}}>local</span>
            <span style={{marginLeft:"auto",cursor:"pointer",color:"#333",fontSize:9}} title="Set USE_LOCAL_STORAGE=false in .env to enable S3">switch to S3 →</span>
          </div>
        )}
        {storageMode && !storageMode.useLocal && storageMode.s3Ready && (
          <div style={{background:"#080d12",border:"1px solid #1a2535",borderRadius:4,padding:"8px 16px",
            marginBottom:18,display:"flex",alignItems:"center",gap:10,color:"#555",fontSize:10,fontFamily:"'Space Mono',monospace"}}>
            ☁️ Storage: <span style={{color:"#38bdf8"}}>S3 ({storageMode.bucket})</span>
          </div>
        )}

        {/* DEFAULT NOTE BANNER */}
        <div className={`default-note-banner ${defaultNote?"default-note-active":""}`}>
          <span style={{fontSize:16}}>📍</span>
          {editingDN ? (
            <>
              <input className="input" style={{flex:1,fontSize:12,padding:"5px 10px"}} autoFocus value={tempDN}
                onChange={e => setTempDN(e.target.value)}
                onKeyDown={e => { if(e.key==="Enter"){saveDefaultNote(tempDN.trim());setEditingDN(false);} if(e.key==="Escape")setEditingDN(false); }}
                placeholder="e.g. Collect a Con · Chicago"/>
              <button className="btn btn-primary btn-sm" onClick={() => {saveDefaultNote(tempDN.trim());setEditingDN(false);}}>Set</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditingDN(false)}>Cancel</button>
            </>
          ) : (
            <>
              <span style={{fontSize:11,color:defaultNote?"#f5a623":"#444",flex:1}}>
                {defaultNote
                  ? <><span style={{color:"#555"}}>Default note: </span><strong>{defaultNote}</strong><span style={{color:"#555"}}> — applied to new transactions</span></>
                  : "No default note — set one for conventions / events"}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => {setTempDN(defaultNote);setEditingDN(true);}}>
                {defaultNote ? "✎ Edit" : "+ Set"}
              </button>
              {defaultNote && <button className="btn btn-danger btn-sm" onClick={() => saveDefaultNote("")}>✕ Clear</button>}
            </>
          )}
        </div>

        {/* PARTNER FILTER BAR */}
        {profiles.filter(p => !p.archived).length > 0 && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"8px 14px",
            background:"#0d0d18",border:"1px solid #1a1a2e",borderRadius:4,flexWrap:"wrap"}}>
            <span style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",flexShrink:0}}>View As</span>
            <button onClick={() => setPartnerFilters([])}
              style={{padding:"3px 12px",borderRadius:20,cursor:"pointer",fontFamily:"'Space Mono',monospace",
                fontSize:10,letterSpacing:1,border:"1px solid #252535",transition:"all 0.15s",
                background:!partnerFilters.length?"#1a1208":"transparent",
                color:!partnerFilters.length?"#f5a623":"#555",
                borderColor:!partnerFilters.length?"#f5a62344":"#252535"}}>
              All
            </button>
            {profiles.filter(p => !p.archived).map(p => {
              const active = partnerFilters.includes(p.id);
              return (
                <button key={p.id} onClick={() => {
                  setPartnerFilters(prev => {
                    if (prev.includes(p.id)) return prev.filter(x => x !== p.id);
                    return [...prev, p.id];
                  });
                }}
                  style={{display:"flex",alignItems:"center",gap:5,padding:"3px 12px",borderRadius:20,cursor:"pointer",
                    fontFamily:"'Space Mono',monospace",fontSize:10,letterSpacing:1,transition:"all 0.15s",
                    background:active ? p.color+"22" : "transparent",
                    color:active ? p.color : "#888",
                    border:`1px solid ${active ? p.color+"66" : "#252535"}`}}>
                  <span style={{width:8,height:8,borderRadius:"50%",background:p.color,flexShrink:0}}/>
                  {p.initials||p.name.slice(0,2).toUpperCase()} · {p.name}
                </button>
              );
            })}
            {activeProfiles.length > 0 && (
              <span style={{fontSize:10,color:"#555",marginLeft:"auto",fontFamily:"'Space Mono',monospace"}}>
                {activeProfiles.length === 1
                  ? <>Showing <span style={{color:activeProfiles[0].color,fontWeight:700}}>{activeProfiles[0].name}</span>'s share</>
                  : <>Showing combined share: {activeProfiles.map((p,i) => <span key={p.id} style={{color:p.color,fontWeight:700}}>{i>0?" + ":""}{p.name}</span>)}</>
                }
              </span>
            )}
          </div>
        )}

        {/* STATS BAR */}
        <div className="grid4" style={{marginBottom:22}}>
          {[
            {label: activeProfiles.length===1 ? `${activeProfiles[0].name}'s Stock` : "In Stock",       val: activeProfiles.length ? `${visibleInStockCards.length} cards` : inStockCards.length+" cards", color:"#4ade80"},
            {label: activeProfiles.length===1 ? `${activeProfiles[0].name}'s Equity` : "Market Value",   val:fmt(stats.mktVal),            color: activeProfiles.length===1 ? activeProfiles[0].color : "#f5a623"},
            {label:`${activeProfiles.length===1 ? activeProfiles[0].name+"'s " : ""}Realized Profit (${soldPeriod})`, val:(stats.periodProfit>=0?"+":"-")+fmt(stats.periodProfit), color:stats.periodProfit>=0?"#4ade80":"#f87171"},
            {label:"Avg Intake %",   val:pct(stats.avgIntake),         color:stats.avgIntake<75?"#4ade80":stats.avgIntake<90?"#fbbf24":"#f87171"},
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{color:s.color}}>{s.val}</div>
            </div>
          ))}
        </div>

        {/* ═══ IN STOCK ═══ */}
        {view === "in_stock" && (
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <h2 className="section-title">IN STOCK</h2>
              <div className="action-row-sm" style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <input className="input" style={{width:200,maxWidth:"100%",fontSize:11,padding:"6px 10px"}}
                  placeholder="Search inventory..." value={inventorySearch}
                  onChange={e => setInventorySearch(e.target.value)}/>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button className="btn btn-primary btn-sm-wide" onClick={() => { setAddCardOwners(getDefaultOwners()); setShowAddCard(true); }}>+ Add Card</button>
                  <button className="btn btn-ghost btn-sm-wide" onClick={() => { setBatchOwners(getDefaultOwners()); setShowBatch(true); }}>📦 Batch Buy</button>
                  <button className="btn btn-ghost btn-sm-wide" onClick={() => openTxModal("sale")}>💰 Sale</button>
                  <button className="btn btn-ghost btn-sm-wide" onClick={() => openTxModal("trade")}>⇄ Trade</button>
                </div>
              </div>
            </div>
            <div className="panel" style={{overflowX:"auto"}}>
              {inStockCards.length===0 ? <div className="empty">No cards in stock. Add some!</div>
               : visibleInStockCards.length===0 ? <div className="empty">No cards match your search.</div>
               : (
                <>
                <table>
                  <thead><tr>
                    <th>Card</th><th className="hide-sm">Grade / Condition</th><th>Buy</th>
                    <th>Mkt @ 🛒</th><th>Current Mkt</th><th className="hide-sm">Mkt Δ</th>
                    <th>Intake %</th><th className="hide-sm">Unrealized</th><th></th>
                  </tr></thead>
                  <tbody>
                    {visibleInStockCards.slice(stockPage*stockPP, (stockPage+1)*stockPP).map(card => {
                      const ip   = card.marketAtPurchase>0 ? (card.buyPrice/card.marketAtPurchase)*100 : null;
                      const pf   = ownerPct(card, partnerFilters);
                      const gain = ((card.currentMarket||0)-card.buyPrice)*pf;
                      const mktD = card.marketAtPurchase&&card.currentMarket
                        ? ((card.currentMarket-card.marketAtPurchase)/card.marketAtPurchase)*100 : null;
                      return (
                        <tr key={card.id}>
                          <td>
                            <div style={{fontWeight:700,fontSize:14,cursor:"pointer"}}
                              onClick={() => setDetailCard(card)}>{toTitleCase(card.name)}</div>
                            {card.owners && card.owners.length > 0 && (
                              <div style={{display:"flex",gap:3,marginTop:3,flexWrap:"wrap"}}>
                                {card.owners.map(o => (
                                  <span key={o.profileId} style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                                    background:o.color+"22",color:o.color,border:`1px solid ${o.color}44`,
                                    fontFamily:"'Space Mono',monospace",letterSpacing:0.5,
                                    fontWeight: partnerFilters.includes(o.profileId) ? 700 : 400,
                                    opacity: partnerFilters.length && !partnerFilters.includes(o.profileId) ? 0.35 : 1}}>
                                    {o.initials||o.name.slice(0,2).toUpperCase()} {o.percentage}%
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="hide-sm"><GradeTag card={card} small/></td>
                          <td>
                            {pf < 1
                              ? <><span style={{color:"#e8e4d9",fontWeight:700}}>{fmt(card.buyPrice*pf)}</span><span style={{fontSize:9,color:"#444",marginLeft:4}}>of {fmt(card.buyPrice)}</span></>
                              : fmt(card.buyPrice)}
                          </td>
                          <td style={{color:"#777"}}>{card.marketAtPurchase?fmt(card.marketAtPurchase):<span style={{color:"#333"}}>—</span>}</td>
                          <td>
                            {editingMarket===card.id ? (
                              <span style={{display:"flex",gap:4,alignItems:"center"}}>
                                <input className="input-inline" type="number" min="0" step="0.01" value={tempMarket} autoFocus
                                  onChange={e => setTempMarket(e.target.value)}
                                  onKeyDown={e => {if(e.key==="Enter")saveMarket(card.id);if(e.key==="Escape")setEditingMarket(null);}}/>
                                <button className="btn btn-ghost btn-sm" onClick={() => saveMarket(card.id)}>✓</button>
                              </span>
                            ) : (
                              <span style={{display:"flex",alignItems:"center",gap:6}}>
                                {pf < 1
                                  ? <><span style={{color:"#f5a623",fontWeight:700}}>{fmt((card.currentMarket||0)*pf)}</span><span style={{fontSize:9,color:"#444"}}>/{fmt(card.currentMarket||0)}</span></>
                                  : <span style={{color:"#f5a623",fontWeight:700}}>{fmt(card.currentMarket||0)}</span>}
                                {pf===1 && <button className="mkt-edit-btn"
                                  onClick={() => {setEditingMarket(card.id);setTempMarket(String(card.currentMarket));}}>✎</button>}
                              </span>
                            )}
                          </td>
                          <td className="hide-sm">
                            {mktD!=null
                              ? <span className={`pct-pill ${mktD>5?"pct-good":mktD<-5?"pct-low":"pct-mid"}`}>{mktD>=0?"+":""}{mktD.toFixed(1)}%</span>
                              : <span style={{color:"#333"}}>—</span>}
                          </td>
                          <td>{ip!=null ? <span className={`pct-pill ${pillCls(ip)}`}>{pct(ip)}</span> : <span style={{color:"#333"}}>—</span>}</td>
                          <td className="hide-sm">
                            <span className={gain>=0?"profit":"loss"} style={{fontWeight:700}}>{gain>=0?"+":"-"}{fmt(gain)}</span>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <div style={{display:"flex",gap:4}}>
                              <button className="edit-btn" onClick={() => {
                                setEditCard({
                                  ...card,
                                  buyPrice:String(card.buyPrice),
                                  marketAtPurchase:String(card.marketAtPurchase),
                                  currentMarket:String(card.currentMarket),
                                });
                                setEditCardOwners(card.owners || []);
                              }}>✎</button>
                              <button className="edit-btn" style={{borderColor:"#7f1d1d44",color:"#b91c1c"}}
                                onClick={() => handleDeleteCard(card.id)}>🗑</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2} style={{color:"#555"}}>{visibleInStockCards.length} cards{activeProfiles.length>0&&<span style={{color:activeProfiles[0].color,marginLeft:6}}>· {activeProfiles.map(p=>p.name).join(' + ')}'s share</span>}</td>
                      <td style={{color:"#aaa",fontWeight:700}}>{fmt(visibleInStockCards.reduce((s,c)=>s+c.buyPrice*ownerPct(c,partnerFilters),0))}</td>
                      <td style={{color:"#666"}}>{fmt(visibleInStockCards.reduce((s,c)=>s+(c.marketAtPurchase||0),0))}</td>
                      <td style={{color:"#f5a623",fontWeight:700}}>{fmt(visibleInStockCards.reduce((s,c)=>s+(c.currentMarket||0)*ownerPct(c,partnerFilters),0))}</td>
                      <td>{(()=>{
                        const t=visibleInStockCards.reduce((s,c)=>s+(c.currentMarket||0),0);
                        const p=visibleInStockCards.reduce((s,c)=>s+(c.marketAtPurchase||0),0);
                        if(!p) return null;
                        const d=((t-p)/p)*100;
                        return <span className={`pct-pill ${d>5?"pct-good":d<-5?"pct-low":"pct-mid"}`}>{d>=0?"+":""}{d.toFixed(1)}%</span>;
                      })()}</td>
                      <td>{(()=>{
                        const cs=visibleInStockCards.filter(c=>c.marketAtPurchase>0);
                        if(!cs.length) return null;
                        const avg=cs.reduce((s,c)=>s+(c.buyPrice/c.marketAtPurchase)*100,0)/cs.length;
                        return <span className={`pct-pill ${pillCls(avg)}`}>{pct(avg)} avg</span>;
                      })()}</td>
                      <td>{(()=>{const g=visibleInStockCards.reduce((s,c)=>s+((c.currentMarket||0)-c.buyPrice)*ownerPct(c,partnerFilters),0);return <span className={g>=0?"profit":"loss"}>{g>=0?"+":"-"}{fmt(g)}</span>;})()}</td>
                      <td/>
                    </tr>
                  </tfoot>
                </table>
                <Paginator total={visibleInStockCards.length} page={stockPage} perPage={stockPP}
                  onPage={setStockPage} onPerPage={setStockPP} pageSizeOptions={[25,50,100,200]}/>
                </>
              )}
            </div>
            {inStockCards.length>0 && <div style={{fontSize:10,color:"#444",marginTop:8}}>Hover a row then click ✎ to update current market price inline. Click a card name for details.</div>}
          </div>
        )}

        {/* ═══ SOLD ═══ */}
        {view === "sold" && (() => {
          const soldSearchLower = soldSearch.trim().toLowerCase();
          // Partner filter: only show cards any selected partner owned
          const partnerSoldCards = partnerFilters.length
            ? filteredSoldCards.filter(c => c.owners?.some(o => partnerFilters.includes(o.profileId)))
            : filteredSoldCards;
          const searchedSoldCards = soldSearchLower
            ? partnerSoldCards.filter(c =>
                (c.name||"").toLowerCase().includes(soldSearchLower) ||
                (c.grade||"").toLowerCase().includes(soldSearchLower) ||
                (c.condition||"").toLowerCase().includes(soldSearchLower))
            : partnerSoldCards;
          const pfRevenue = (c) => (c.salePrice||0) * ownerPct(c, partnerFilters);
          const pfCost    = (c) => c.buyPrice * ownerPct(c, partnerFilters);
          const periodRevenue = searchedSoldCards.reduce((s,c)=>s+pfRevenue(c),0);
          const periodCost    = searchedSoldCards.reduce((s,c)=>s+pfCost(c),0);
          const periodProfit  = periodRevenue - periodCost;
          return (
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
                <h2 className="section-title">SOLD / TRADED</h2>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <input className="input" style={{width:190,fontSize:11,padding:"6px 10px"}}
                    placeholder="Search sold cards..." value={soldSearch}
                    onChange={e=>setSoldSearch(e.target.value)}/>
                  <select className="select" style={{width:"auto"}} value={soldPeriod} onChange={e => setSoldPeriod(e.target.value)}>
                    <option value={currentMonthKey}>This Month ({currentMonthKey})</option>
                    {soldMonths.filter(m=>m!==currentMonthKey).map(m => <option key={m} value={m}>{m}</option>)}
                    <option value="all">All Time</option>
                  </select>
                  <button className="btn btn-ghost" onClick={() => openTxModal("sale")}>💰 Record Sale</button>
                </div>
              </div>
              {searchedSoldCards.length>0 && (
                <div className="grid4" style={{marginBottom:14}}>
                  {[
                    {label:"Cards Sold",     val:searchedSoldCards.length,  color:"#e8e4d9"},
                    {label:"Revenue",        val:fmt(periodRevenue),         color:"#4ade80"},
                    {label:"Cost Basis",     val:fmt(periodCost),            color:"#f87171"},
                    {label:"Realized Profit",val:(periodProfit>=0?"+":"-")+fmt(periodProfit), color:periodProfit>=0?"#4ade80":"#f87171"},
                  ].map(s=>(
                    <div key={s.label} style={{background:"#0e0e18",border:"1px solid #1e1e28",borderRadius:4,padding:"10px 14px"}}>
                      <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:5}}>{s.label}</div>
                      <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:18,color:s.color}}>{s.val}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="panel" style={{overflowX:"auto"}}>
                {searchedSoldCards.length===0 ? (
                  <div className="empty">
                    {soldSearch ? `No cards matching "${soldSearch}".` : <>No {soldPeriod==="all"?"":"sold cards in "+soldPeriod+". "}
                    {soldPeriod!=="all" && <span style={{color:"#f5a623",cursor:"pointer"}} onClick={()=>setSoldPeriod("all")}>View all time →</span>}</>}
                  </div>
                ) : (
                  <>
                  <table>
                    <thead><tr>
                      <th>Card</th><th>Grade</th><th>Status</th>
                      <th>Buy</th><th>Mkt @ Purchase</th><th>Mkt @ Sale</th>
                      <th>Intake %</th><th>Sale Price</th><th>Sale %</th><th>Profit</th><th></th>
                    </tr></thead>
                    <tbody>
                      {searchedSoldCards.slice(soldPage*soldPP, (soldPage+1)*soldPP).map(card => {
                        const ip = card.marketAtPurchase>0 ? (card.buyPrice/card.marketAtPurchase)*100 : null;
                        const sp = card.salePrice!=null&&card.currentMarket>0 ? (card.salePrice/card.currentMarket)*100 : null;
                        const pf = ownerPct(card, partnerFilters);
                        const p  = card.salePrice!=null ? (card.salePrice-card.buyPrice)*pf : null;
                        return (
                          <tr key={card.id}>
                            <td>
                              <div style={{fontWeight:700,cursor:"pointer",textTransform:"capitalize"}}
                                onClick={()=>setDetailCard(card)}>{toTitleCase(card.name)}</div>
                              {card.owners?.length > 0 && (
                                <div style={{display:"flex",gap:3,marginTop:2,flexWrap:"wrap"}}>
                                  {card.owners.map(o => (
                                    <span key={o.profileId} style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                                      background:o.color+"22",color:o.color,border:`1px solid ${o.color}44`,
                                      fontFamily:"'Space Mono',monospace",
                                      fontWeight: partnerFilters.includes(o.profileId) ? 700 : 400,
                                      opacity: partnerFilters.length && !partnerFilters.includes(o.profileId) ? 0.35 : 1}}>
                                      {o.initials||o.name.slice(0,2).toUpperCase()} {o.percentage}%
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td><GradeTag card={card} small/></td>
                            <td><span className="tag" style={{background:card.status==="sold"?"#7f1d1d33":"#43140733",color:card.status==="sold"?"#f87171":"#fb923c"}}>{card.status.toUpperCase()}</span></td>
                            <td style={{color:"#888"}}>
                              {pf<1 ? <><span style={{fontWeight:700}}>{fmt(card.buyPrice*pf)}</span><span style={{fontSize:9,color:"#444",marginLeft:3}}>/{fmt(card.buyPrice)}</span></> : fmt(card.buyPrice)}
                            </td>
                            <td style={{color:"#666"}}>{card.marketAtPurchase?fmt(card.marketAtPurchase):"—"}</td>
                            <td style={{color:"#aaa"}}>{card.currentMarket?fmt(card.currentMarket):"—"}</td>
                            <td>{ip!=null?<span className={`pct-pill ${pillCls(ip)}`}>{pct(ip)}</span>:"—"}</td>
                            <td style={{fontWeight:700}}>
                              {card.salePrice!=null ? (pf<1 ? <><span>{fmt(card.salePrice*pf)}</span><span style={{fontSize:9,color:"#444",marginLeft:3}}>/{fmt(card.salePrice)}</span></> : fmt(card.salePrice)) : "—"}
                            </td>
                            <td>{sp!=null?<span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>:"—"}</td>
                            <td>{p!=null?<span className={p>=0?"profit":"loss"} style={{fontWeight:700}}>{p>=0?"+":"-"}{fmt(Math.abs(p))}</span>:"—"}</td>
                            <td><button className="edit-btn" onClick={() => setEditSold({...card,buyPrice:String(card.buyPrice),marketAtPurchase:String(card.marketAtPurchase),currentMarket:String(card.currentMarket),salePrice:String(card.salePrice??'')})}>✎</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3} style={{color:"#555"}}>{searchedSoldCards.length} cards{activeProfiles.length>0&&<span style={{color:activeProfiles[0].color,marginLeft:6}}>· {activeProfiles.map(p=>p.name).join(' + ')}'s share</span>}</td>
                        <td style={{color:"#888"}}>{fmt(searchedSoldCards.reduce((s,c)=>s+pfCost(c),0))}</td>
                        <td style={{color:"#666"}}>{fmt(searchedSoldCards.reduce((s,c)=>s+(c.marketAtPurchase||0),0))}</td>
                        <td style={{color:"#aaa"}}>{fmt(searchedSoldCards.reduce((s,c)=>s+(c.currentMarket||0),0))}</td>
                        <td>{(()=>{const cs=searchedSoldCards.filter(c=>c.marketAtPurchase>0);if(!cs.length)return null;const avg=cs.reduce((s,c)=>s+(c.buyPrice/c.marketAtPurchase)*100,0)/cs.length;return<span className={`pct-pill ${pillCls(avg)}`}>{pct(avg)} avg</span>;})()}</td>
                        <td style={{fontWeight:700}}>{fmt(searchedSoldCards.reduce((s,c)=>s+pfRevenue(c),0))}</td>
                        <td>{(()=>{const cs=searchedSoldCards.filter(c=>c.salePrice&&c.currentMarket);if(!cs.length)return null;const avg=cs.reduce((s,c)=>s+(c.salePrice/c.currentMarket)*100,0)/cs.length;return<span className={`pct-pill ${salePillCls(avg)}`}>{pct(avg)} avg</span>;})()}</td>
                        <td>{(()=>{const p=searchedSoldCards.reduce((s,c)=>s+((c.salePrice||0)-c.buyPrice)*ownerPct(c,partnerFilters),0);return<span className={p>=0?"profit":"loss"}>{p>=0?"+":"-"}{fmt(Math.abs(p))}</span>;})()}</td>
                        <td/>
                      </tr>
                    </tfoot>
                  </table>
                  <Paginator total={searchedSoldCards.length} page={soldPage} perPage={soldPP}
                    onPage={setSoldPage} onPerPage={setSoldPP} pageSizeOptions={[25,50,100,200]}/>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {/* ═══ TRANSACTIONS ═══ */}
        {view === "transactions" && (() => {
          const allFilteredTx = txFilterMode==="all"
            ? [...transactions].reverse()
            : [...transactions].filter(t=>t.date===txDateFilter).reverse();
          // Partner filter: show only transactions involving any selected partner's cards
          const filteredTx = partnerFilters.length
            ? allFilteredTx.filter(t =>
                t.cardsOut.some(co => {
                  const inv = inventory.find(c => c.id === co.id);
                  return inv?.owners?.some(o => partnerFilters.includes(o.profileId));
                }) ||
                inventory.some(c => c.transactionId === t.id && c.owners?.some(o => partnerFilters.includes(o.profileId)))
              )
            : allFilteredTx;
          const dayCashIn   = filteredTx.reduce((s,t)=>s+t.cashIn,0);
          const dayCashOut  = filteredTx.reduce((s,t)=>s+t.cashOut,0);
          const dayVenmoIn  = filteredTx.reduce((s,t)=>s+Math.max(0,t.venmoAmount||0),0);
          const dayVenmoOut = filteredTx.reduce((s,t)=>s+Math.max(0,-(t.venmoAmount||0)),0);
          const dayZelleIn  = filteredTx.reduce((s,t)=>s+Math.max(0,t.zelleAmount||0),0);
          const dayZelleOut = filteredTx.reduce((s,t)=>s+Math.max(0,-(t.zelleAmount||0)),0);
          const dayNetCash  = (dayCashIn + dayVenmoIn + dayZelleIn) - (dayCashOut + dayVenmoOut + dayZelleOut);
          const dayProfit  = filteredTx.reduce((s,t) => {
            if (t.marketProfit != null) return s + t.marketProfit;
            const v = t.venmoAmount || 0;
            const z = t.zelleAmount || 0;
            const flowIn  = t.cashIn  + Math.max(0,v)  + Math.max(0,z);
            const flowOut = t.cashOut + Math.max(0,-v) + Math.max(0,-z);
            const tradeIn = t.cardsIn.reduce((cs,ci)=>cs+(toF(ci.currentMarket)||toF(ci.marketAtPurchase)||0),0);
            const basis   = t.cardsOut.reduce((cs,co)=>{const inv=inventory.find(x=>x.id===co.id);return cs+(inv?inv.buyPrice:0);},0);
            return s + (flowIn + tradeIn) - (basis + flowOut);
          },0);
          const txDates = [...new Set(transactions.map(t=>t.date))].sort((a,b)=>b.localeCompare(a));
          return (
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
                <h2 className="section-title">TRANSACTIONS</h2>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <div style={{display:"flex",border:"1px solid #252535",borderRadius:3,overflow:"hidden"}}>
                    {[{k:"day",l:"📅 Day"},{k:"all",l:"All Time"}].map(m=>(
                      <button key={m.k} onClick={()=>setTxFilterMode(m.k)}
                        style={{background:txFilterMode===m.k?"#f5a623":"#141420",color:txFilterMode===m.k?"#0a0a0f":"#666",border:"none",padding:"6px 12px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:10,letterSpacing:1,textTransform:"uppercase",fontWeight:txFilterMode===m.k?700:400}}>
                        {m.l}
                      </button>
                    ))}
                  </div>
                  {txFilterMode==="day" && <input type="date" className="input" value={txDateFilter} onChange={e=>setTxDateFilter(e.target.value)} style={{width:"auto",padding:"6px 10px"}}/>}
                  <button className="btn btn-ghost" onClick={()=>openTxModal("sale")}>💰 Sale</button>
                  <button className="btn btn-ghost" onClick={()=>openTxModal("trade")}>⇄ Trade</button>
                </div>
              </div>

              {txFilterMode==="day" && txDates.length>0 && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
                  {txDates.map(d=>{
                    const dayT   = transactions.filter(t=>t.date===d);
                    const cashIn = dayT.reduce((s,t)=>s+t.cashIn,0);
                    const cashOut= dayT.reduce((s,t)=>s+t.cashOut,0);
                    const vIn    = dayT.reduce((s,t)=>s+Math.max(0,t.venmoAmount||0),0);
                    const vOut   = dayT.reduce((s,t)=>s+Math.max(0,-(t.venmoAmount||0)),0);
                    const zIn    = dayT.reduce((s,t)=>s+Math.max(0,t.zelleAmount||0),0);
                    const zOut   = dayT.reduce((s,t)=>s+Math.max(0,-(t.zelleAmount||0)),0);
                    const rev    = (cashIn+vIn+zIn)-(cashOut+vOut+zOut);
                    const isA    = d===txDateFilter;
                    return (
                      <button key={d} onClick={()=>setTxDateFilter(d)}
                        style={{background:isA?"#1a1208":"#111118",border:isA?"1px solid #f5a623":"1px solid #1e1e28",borderRadius:3,padding:"5px 12px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:10,color:isA?"#f5a623":"#777",display:"flex",gap:8,alignItems:"center"}}>
                        <span>{d}</span>
                        <span style={{color:rev>=0?"#f5a623":"#f87171",fontWeight:700}}>{rev>=0?"+":"-"}{fmt(rev)}</span>
                        <span style={{color:"#444"}}>{dayT.length}tx</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {filteredTx.length>0 && (
                <div style={{marginBottom:16}}>

                  {/* ── Cash Row ──────────────────────────────────── */}
                  <div style={{fontSize:9,letterSpacing:2,color:"#4ade8066",textTransform:"uppercase",marginBottom:4,paddingLeft:2}}>💵 Cash</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:5,marginBottom:8}}>
                    {[
                      {label:"Cash In",  val:fmt(dayCashIn),  color:"#4ade80", bg:"#0a1208", border:"#16a34a22"},
                      {label:"Cash Out", val:fmt(dayCashOut), color:"#f87171", bg:"#120a0a", border:"#dc262622"},
                      {label:"Net 💵", val:(dayCashIn-dayCashOut>=0?"+":"-")+fmt(dayCashIn-dayCashOut),
                        color:(dayCashIn-dayCashOut)>=0?"#4ade80":"#f87171", bg:"#0e0e18", border:"#1e1e28"},
                    ].map(s=>(
                      <div key={s.label} style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:4,padding:"8px 12px"}}>
                        <div style={{fontSize:9,letterSpacing:1.5,color:"#555",textTransform:"uppercase",marginBottom:3}}>{s.label}</div>
                        <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:15,color:s.color}}>{s.val}</div>
                      </div>
                    ))}
                  </div>

                  {/* ── Venmo Row (only if any venmo) ─────────────── */}
                  {(dayVenmoIn>0||dayVenmoOut>0)&&(
                    <>
                      <div style={{fontSize:9,letterSpacing:2,color:"#2563eb66",textTransform:"uppercase",marginBottom:4,paddingLeft:2}}>💙 Venmo</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:5,marginBottom:8}}>
                        {[
                          {label:"Venmo In",  val:"+"+fmt(dayVenmoIn),  color:"#60a5fa", bg:"#08101a", border:"#2563eb22"},
                          {label:"Venmo Out", val:"-"+fmt(dayVenmoOut), color:"#f87171", bg:"#08101a", border:"#2563eb22"},
                          {label:"Net Venmo", val:(dayVenmoIn-dayVenmoOut>=0?"+":"-")+fmt(dayVenmoIn-dayVenmoOut),
                            color:(dayVenmoIn-dayVenmoOut)>=0?"#60a5fa":"#f87171", bg:"#060c14", border:"#2563eb33"},
                        ].map(s=>(
                          <div key={s.label} style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:4,padding:"8px 12px"}}>
                            <div style={{fontSize:9,letterSpacing:1.5,color:"#2563eb88",textTransform:"uppercase",marginBottom:3}}>{s.label}</div>
                            <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:15,color:s.color}}>{s.val}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {/* ── Zelle Row (only if any zelle) ─────────────── */}
                  {(dayZelleIn>0||dayZelleOut>0)&&(
                    <>
                      <div style={{fontSize:9,letterSpacing:2,color:"#9333ea66",textTransform:"uppercase",marginBottom:4,paddingLeft:2}}>💜 Zelle</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:5,marginBottom:8}}>
                        {[
                          {label:"Zelle In",  val:"+"+fmt(dayZelleIn),  color:"#c084fc", bg:"#100818", border:"#9333ea22"},
                          {label:"Zelle Out", val:"-"+fmt(dayZelleOut), color:"#f87171", bg:"#100818", border:"#9333ea22"},
                          {label:"Net Zelle", val:(dayZelleIn-dayZelleOut>=0?"+":"-")+fmt(dayZelleIn-dayZelleOut),
                            color:(dayZelleIn-dayZelleOut)>=0?"#c084fc":"#f87171", bg:"#0c0614", border:"#9333ea33"},
                        ].map(s=>(
                          <div key={s.label} style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:4,padding:"8px 12px"}}>
                            <div style={{fontSize:9,letterSpacing:1.5,color:"#9333ea88",textTransform:"uppercase",marginBottom:3}}>{s.label}</div>
                            <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:15,color:s.color}}>{s.val}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {/* ── Summary Row ───────────────────────────────── */}
                  {(()=>{
                    const totalIn  = dayCashIn  + dayVenmoIn  + dayZelleIn;
                    const totalOut = dayCashOut + dayVenmoOut + dayZelleOut;
                    const revenue  = totalIn - totalOut;
                    return (
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:5}}>
                        {[
                          {label:"Transactions", val:filteredTx.length+" total",          color:"#e8e4d9", bg:"#0e0e18", border:"#1e1e28"},
                          {label:"Total In",     val:"+"+fmt(totalIn),                    color:"#4ade80", bg:"#0a1208", border:"#16a34a22"},
                          {label:"Total Out",    val:"-"+fmt(totalOut),                   color:"#f87171", bg:"#120a0a", border:"#dc262622"},
                          {label:"Revenue",      val:(revenue>=0?"+":"-")+fmt(revenue),   color:revenue>=0?"#f5a623":"#f87171", bg:revenue>=0?"#1a1208":"#1a0808", border:revenue>=0?"#f5a62344":"#f8717144"},
                          {label:"Mkt Profit",   val:(dayProfit>=0?"+":"-")+fmt(dayProfit), color:dayProfit>=0?"#4ade80":"#f87171", bg:"#0e0e18", border:"#1e1e28"},
                        ].map(s=>(
                          <div key={s.label} style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:4,padding:"8px 12px"}}>
                            <div style={{fontSize:9,letterSpacing:1.5,color:"#555",textTransform:"uppercase",marginBottom:3}}>{s.label}</div>
                            <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:15,color:s.color}}>{s.val}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {filteredTx.length===0 && (
                <div className="empty">
                  {transactions.length===0 ? "No transactions yet." : txFilterMode==="day" ? `No transactions on ${txDateFilter}.` : "No transactions."}
                </div>
              )}

              {filteredTx.length > 0 && (
                <Paginator total={filteredTx.length} page={txPage} perPage={txPP}
                  onPage={setTxPage} onPerPage={setTxPP} pageSizeOptions={[10,20,50,100]}/>
              )}

              {filteredTx.slice(txPage*txPP, (txPage+1)*txPP).map(t => {
                const cardsCostBasis = t.cardsOut.reduce((s,co)=>{const inv=inventory.find(x=>x.id===co.id);return s+(inv?inv.buyPrice:0);},0);
                const venmo       = t.venmoAmount || 0;
                const zelle       = t.zelleAmount || 0;
                const totalPaidOut = t.cashOut + Math.max(0,-venmo) + Math.max(0,-zelle);
                // Cost basis = original buy prices of cards going out + any cash/venmo/zelle paid out
                const costBasis   = cardsCostBasis + totalPaidOut;
                const netRevenue  = (t.cashIn + Math.max(0,venmo) + Math.max(0,zelle))
                                  - (t.cashOut + Math.max(0,-venmo) + Math.max(0,-zelle));
                const txProfit  = t.marketProfit != null ? t.marketProfit : (()=>{
                  const v = t.venmoAmount || 0;
                  const z = t.zelleAmount || 0;
                  const flowIn  = t.cashIn  + Math.max(0,v)  + Math.max(0,z);
                  const flowOut = t.cashOut + Math.max(0,-v) + Math.max(0,-z);
                  const tradeIn = (t.cardsIn||[]).reduce((s,ci)=>s+(toF(ci.currentMarket)||toF(ci.marketAtPurchase)||0),0);
                  // cost basis = what we originally paid for cards that went out
                  const basis   = t.cardsOut.reduce((s,co)=>{const inv=inventory.find(x=>x.id===co.id);return s+(inv?inv.buyPrice:0);},0);
                  return (flowIn + tradeIn) - (basis + flowOut);
                })();
                // BUG FIX: added "BUY" case
                const txTypeLabel = t.type==="sale" ? "SALE" : t.type==="trade" ? "TRADE" : "BUY";
                const txClass     = t.type==="sale" ? "tx-sale" : t.type==="trade" ? "tx-trade" : "tx-buy";
                const txTagBg     = t.type==="sale" ? "#14532d44" : t.type==="trade" ? "#43140744" : "#0c4a6e44";
                const txTagColor  = t.type==="sale" ? "#4ade80" : t.type==="trade" ? "#fb923c" : "#38bdf8";
                return (
                  <div key={t.id} className={`tx-card ${txClass}`}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,gap:8,flexWrap:"wrap",cursor:"pointer"}}
                      onClick={()=>setDetailTx(t)}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",flex:1,minWidth:0}}>
                        <span className="tag" style={{background:txTagBg,color:txTagColor,flexShrink:0}}>{txTypeLabel}</span>
                        {txFilterMode==="all" && <span style={{fontSize:11,color:"#555",flexShrink:0}}>{t.date}</span>}
                        {t.notes && <span style={{fontSize:11,color:"#888",background:"#1a1a10",border:"1px solid #2a2a18",borderRadius:3,padding:"1px 8px"}}>📍 {t.notes}</span>}
                        {t.imageUrl && <span style={{fontSize:10,color:"#555"}}>📷</span>}
                        {t.paymentMethod && t.paymentMethod.split(',').map(pm=>pm.trim()).filter(Boolean).map(pm=>{
                          const amt = pm==="venmo" ? t.venmoAmount
                            : pm==="zelle" ? t.zelleAmount
                            : pm==="cash"  ? (t.cashIn>0.005 ? t.cashIn : t.cashOut>0.005 ? -t.cashOut : null)
                            : null;
                          return (
                            <span key={pm} style={{fontSize:10,fontFamily:"'Space Mono',monospace",letterSpacing:1,background:pm==="cash"?"#141a0a":pm==="venmo"?"#080e1a":"#10081a",color:pm==="cash"?"#86efac":pm==="venmo"?"#60a5fa":"#c084fc",border:`1px solid ${pm==="cash"?"#16a34a33":pm==="venmo"?"#2563eb33":"#9333ea33"}`,borderRadius:3,padding:"1px 7px",textTransform:"uppercase",flexShrink:0}}>
                              {pm==="cash"?"💵":pm==="venmo"?"💙":"💜"} {pm}{amt!=null?` ${amt>=0?"+":"-"}${fmt(Math.abs(amt))}`:""}
                            </span>
                          );
                        })}
                        <span onClick={e=>{e.stopPropagation();openEditTx(t);}} className="edit-btn">✎ Edit</span>
                        <span onClick={e=>{e.stopPropagation();handleUndoTransaction(t.id);}} className="edit-btn" style={{borderColor:"#7f1d1d44",color:"#b91c1c"}}>↩ Undo</span>
                      </div>
                      <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:9,color:"#555",letterSpacing:1.5,textTransform:"uppercase"}}>Net Revenue</div>
                          <div style={{color:netRevenue>=0?"#f5a623":"#f87171",fontWeight:700,fontSize:14}}>{netRevenue>=0?"+":"-"}{fmt(netRevenue)}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:9,color:"#555",letterSpacing:1.5,textTransform:"uppercase"}}>Mkt Profit</div>
                          <div className={txProfit>=0?"profit":"loss"} style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:18}}>{txProfit>=0?"+":"-"}{fmt(txProfit)}</div>
                        </div>
                      </div>
                    </div>

                    {t.cardsOut.length>0 && (
                      <div style={{marginBottom:t.cardsIn.length?10:0,marginTop:t.imageUrl?8:0}}>
                        <div style={{fontSize:9,color:"#f87171",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>Cards Out</div>
                        {t.cardsOut.map((co,i)=>{
                          const card=inventory.find(c=>c.id===co.id);
                          const ip=card&&card.marketAtPurchase>0?(card.buyPrice/card.marketAtPurchase)*100:null;
                          const sp=co.salePrice!=null&&co.currentMarket>0?(co.salePrice/co.currentMarket)*100:null;
                          return <div key={i} className="prev-row" style={{flexWrap:"wrap",gap:"3px 8px"}}>
                            <span style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                              <span style={{color:"#e8e4d9",fontWeight:700,fontSize:13,cursor:"pointer"}}
                                onClick={()=>card&&setDetailCard(card)}>{toTitleCase(co.name)}</span>
                              {co.grade&&<span style={{fontSize:10,color:"#a78bfa"}}>{co.grade}</span>}
                              {co.owners?.length>0&&co.owners.map(o=>(
                                <span key={o.profileId} style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                                  background:o.color+"22",color:o.color,border:`1px solid ${o.color}44`,
                                  fontFamily:"'Space Mono',monospace",
                                  fontWeight:partnerFilters.includes(o.profileId)?700:400,
                                  opacity:partnerFilters.length&&!partnerFilters.includes(o.profileId)?0.35:1}}>
                                  {o.initials||o.name.slice(0,2).toUpperCase()} {o.percentage}%
                                </span>
                              ))}
                            </span>
                            <span style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                              {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`}>in {pct(ip)}</span>}
                              {card?.buyPrice>0&&<span style={{color:"#666",fontSize:10}}>bought {fmt(card.buyPrice)}</span>}
                              <span style={{color:"#555"}}>mkt {fmt(co.currentMarket||0)}</span>
                              {co.salePrice!=null&&<span style={{color:"#e8e4d9",fontWeight:700}}>→ {fmt(co.salePrice)}</span>}
                              {sp!=null&&<span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>}
                            </span>
                          </div>;
                        })}
                      </div>
                    )}
                    {t.cardsIn.length>0 && (
                      <div>
                        <div style={{fontSize:9,color:"#4ade80",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>Cards In</div>
                        {t.cardsIn.map((ci,i)=>{
                          const card=inventory.find(c=>c.transactionId===t.id&&(c.name||'').toLowerCase()===(ci.name||'').toLowerCase());
                          const ip=toF(ci.marketAtPurchase)>0?(toF(ci.buyPrice)/toF(ci.marketAtPurchase))*100:null;
                          const owners=card?.owners||[];
                          return <div key={i} className="prev-row" style={{flexWrap:"wrap",gap:"3px 8px"}}>
                            <span style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                              <span style={{color:"#e8e4d9",fontWeight:700,fontSize:13,cursor:card?"pointer":"default"}}
                                onClick={()=>card&&setDetailCard(card)}>{toTitleCase(ci.name)}</span>
                              {ci.isGraded&&ci.grade&&<span style={{fontSize:10,color:"#a78bfa"}}>{ci.grade}</span>}
                              {owners.length>0&&owners.map(o=>(
                                <span key={o.profileId} style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                                  background:o.color+"22",color:o.color,border:`1px solid ${o.color}44`,
                                  fontFamily:"'Space Mono',monospace",
                                  fontWeight:partnerFilters.includes(o.profileId)?700:400,
                                  opacity:partnerFilters.length&&!partnerFilters.includes(o.profileId)?0.35:1}}>
                                  {o.initials||o.name.slice(0,2).toUpperCase()} {o.percentage}%
                                </span>
                              ))}
                            </span>
                            <span style={{display:"flex",gap:8,alignItems:"center"}}>
                              <span style={{color:"#555"}}>mkt {fmt(toF(ci.currentMarket)||toF(ci.marketAtPurchase))}</span>
                              {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`}>in {pct(ip)}</span>}
                              {toF(ci.buyPrice)>0&&<span style={{color:"#666",fontSize:10}}>bought {fmt(toF(ci.buyPrice))}</span>}
                            </span>
                          </div>;
                        })}
                      </div>
                    )}
                    <div style={{display:"flex",gap:16,marginTop:10,paddingTop:10,borderTop:"1px solid #131320",fontSize:11,flexWrap:"wrap",alignItems:"center"}}>
                      {t.cashIn  > 0.005 && <span className="profit">+{fmt(t.cashIn)} 💵</span>}
                      {t.cashOut > 0.005 && <span className="loss">-{fmt(t.cashOut)} 💵 out</span>}
                      {venmo > 0.005  && <span style={{color:"#60a5fa"}}>+{fmt(venmo)} 💙</span>}
                      {venmo < -0.005 && <span style={{color:"#f87171"}}>-{fmt(Math.abs(venmo))} 💜 out</span>}
                      {zelle > 0.005  && <span style={{color:"#c084fc"}}>+{fmt(zelle)} 💜</span>}
                      {zelle < -0.005 && <span style={{color:"#f87171"}}>-{fmt(Math.abs(zelle))} 💙 out</span>}
                      {t.cashIn===0&&t.cashOut===0&&!venmo&&!zelle&&<span style={{color:"#333"}}>No cash exchanged</span>}
                      <span style={{color:"#444",marginLeft:"auto",fontSize:10}}>cost basis {fmt(costBasis)}</span>
                    </div>
                    {/* Partner share strip */}
                    {activeProfiles.length > 0 && (()=>{
                      const partnerCardsOut = t.cardsOut.map(co => {
                        const inv = inventory.find(c => c.id === co.id);
                        const pct = activeProfiles.reduce((s,p) =>
                          s + (inv?.owners?.find(o => o.profileId === p.id)?.percentage || 0) / 100, 0);
                        return { ...co, pct, buyPrice: inv?.buyPrice || 0 };
                      }).filter(co => co.pct > 0);
                      const partnerRev   = partnerCardsOut.reduce((s,co) => s+(co.salePrice||0)*co.pct, 0);
                      const partnerCost  = partnerCardsOut.reduce((s,co) => s+co.buyPrice*co.pct, 0);
                      const partnerProfit= partnerRev - partnerCost;
                      if (!partnerCardsOut.length) return null;
                      return (
                        <div style={{marginTop:8,padding:"8px 12px",background:"#0a0a14",
                          border:`1px solid #1e1e30`,borderRadius:3,display:"flex",gap:14,flexWrap:"wrap",alignItems:"center"}}>
                          <div style={{display:"flex",gap:4}}>
                            {activeProfiles.map(p => <div key={p.id} style={{width:6,height:6,borderRadius:"50%",background:p.color}}/>)}
                          </div>
                          <span style={{fontSize:9,color:"#aaa",letterSpacing:1.5,textTransform:"uppercase",fontWeight:700}}>
                            {activeProfiles.map(p=>p.name).join(" + ")}'s Share
                          </span>
                          <span style={{fontSize:11,color:"#aaa"}}>rev <span style={{color:"#4ade80",fontWeight:700}}>{fmt(partnerRev)}</span></span>
                          <span style={{fontSize:11,color:"#aaa"}}>cost <span style={{color:"#f87171",fontWeight:700}}>{fmt(partnerCost)}</span></span>
                          <span style={{fontSize:11,color:"#aaa"}}>profit <span className={partnerProfit>=0?"profit":"loss"} style={{fontWeight:700}}>{partnerProfit>=0?"+":"-"}{fmt(Math.abs(partnerProfit))}</span></span>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
              {filteredTx.length > txPP && (
                <Paginator total={filteredTx.length} page={txPage} perPage={txPP}
                  onPage={setTxPage} onPerPage={setTxPP} pageSizeOptions={[10,20,50,100]}/>
              )}
            </div>
          );
        })()}

        {/* ═══ ANALYTICS ═══ */}
        {view === "stats" && (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
              <h2 className="section-title">ANALYTICS</h2>
              {activeProfiles.length > 0 && (
                <span style={{display:"flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:20,
                  background:"#1a1a2e",border:"1px solid #2a2a40",fontSize:11,fontFamily:"'Space Mono',monospace",color:"#aaa"}}>
                  {activeProfiles.map((p,i) => <span key={p.id} style={{color:p.color,fontWeight:700}}>{i>0?" + ":""}{p.name}</span>)}'s view
                </span>
              )}
            </div>
            <div className="grid4" style={{marginBottom:18}}>
              {[
                {label: activeProfiles.length===1 ? `${activeProfiles[0].name}'s Revenue`   : "Revenue",        val:fmt(stats.revenue),     color:"#4ade80"},
                {label: activeProfiles.length===1 ? `${activeProfiles[0].name}'s Cost`      : "Cost of Sold",   val:fmt(stats.costOfSold),  color:"#f87171"},
                {label: activeProfiles.length===1 ? `${activeProfiles[0].name}'s Profit`    : "Realized Profit",val:(stats.profit>=0?"+":"-")+fmt(stats.profit), color:stats.profit>=0?"#4ade80":"#f87171"},
                {label:"Mkt Appreciation", val:(()=>{const t=visibleInStockCards.reduce((s,c)=>s+(c.currentMarket||0)*ownerPct(c,partnerFilters),0),p=visibleInStockCards.reduce((s,c)=>s+(c.marketAtPurchase||0)*ownerPct(c,partnerFilters),0),d=t-p;return(d>=0?"+":"-")+fmt(Math.abs(d));})(),
                  color:(()=>{const d=visibleInStockCards.reduce((s,c)=>s+(c.currentMarket||0)*ownerPct(c,partnerFilters),0)-visibleInStockCards.reduce((s,c)=>s+(c.marketAtPurchase||0)*ownerPct(c,partnerFilters),0);return d>=0?"#4ade80":"#f87171";})()},
              ].map(s=><div key={s.label} className="stat-card"><div className="stat-label">{s.label}</div><div className="stat-value" style={{color:s.color}}>{s.val}</div></div>)}
            </div>
            <div className="grid2" style={{gap:16}}>
              <div className="panel" style={{padding:20}}>
                <div style={{fontSize:9,color:"#555",letterSpacing:2,textTransform:"uppercase",marginBottom:14}}>Graded vs Raw</div>
                {[{l:"Graded In Stock",f:c=>c.isGraded&&c.status==="in_stock"},{l:"Raw In Stock",f:c=>!c.isGraded&&c.status==="in_stock"},{l:"Graded Sold",f:c=>c.isGraded&&c.status!=="in_stock"},{l:"Raw Sold",f:c=>!c.isGraded&&c.status!=="in_stock"}].map(r=>(
                  <div key={r.l} style={{display:"flex",justifyContent:"space-between",marginBottom:10,fontSize:12}}>
                    <span style={{color:"#aaa"}}>{r.l}</span><span style={{color:"#555"}}>{inventory.filter(r.f).length} cards</span>
                  </div>
                ))}
                <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid #1a1a28"}}>
                  {["PSA","BGS","CGC","SGC","ACE"].map(co=>{const n=inventory.filter(c=>c.gradingCompany===co).length;return n?<div key={co} style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:6}}><span style={{color:"#777"}}>{co}</span><span style={{color:"#555"}}>{n} slabs</span></div>:null;})}
                </div>
              </div>
              <div className="panel" style={{padding:20}}>
                <div style={{fontSize:9,color:"#555",letterSpacing:2,textTransform:"uppercase",marginBottom:14}}>Rate Averages</div>
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,color:"#aaa",marginBottom:6}}>Avg Intake % <span style={{color:"#555",fontSize:10}}>(buy / mkt @ purchase)</span></div>
                  <span className={`pct-pill ${pillCls(stats.avgIntake)}`} style={{fontSize:14,padding:"3px 12px"}}>{pct(stats.avgIntake)}</span>
                  <div style={{fontSize:10,color:"#444",marginTop:4}}>Lower is better</div>
                </div>
                {(()=>{const cs=soldCards.filter(c=>c.salePrice&&c.currentMarket);if(!cs.length)return null;const avg=cs.reduce((s,c)=>s+(c.salePrice/c.currentMarket)*100,0)/cs.length;return(
                  <div>
                    <div style={{fontSize:11,color:"#aaa",marginBottom:6}}>Avg Sale % <span style={{color:"#555",fontSize:10}}>(sale / mkt @ sale)</span></div>
                    <span className={`pct-pill ${salePillCls(avg)}`} style={{fontSize:14,padding:"3px 12px"}}>{pct(avg)}</span>
                    <div style={{fontSize:10,color:"#444",marginTop:4}}>Higher is better</div>
                  </div>
                );})()}
              </div>
            </div>

            {/* ── Per-Partner Equity Breakdown ───────────────── */}
            {profiles.length > 0 && (()=>{
              // For each profile, calculate their stake across all cards
              const partnerStats = profiles.map(p => {
                const inStock  = inventory.filter(c => c.status === "in_stock" && c.owners?.some(o => o.profileId === p.id));
                const sold     = inventory.filter(c => c.status !== "in_stock" && c.owners?.some(o => o.profileId === p.id));
                const getPct   = c => (c.owners?.find(o => o.profileId === p.id)?.percentage || 0) / 100;

                const equity      = inStock.reduce((s,c) => s + (c.currentMarket||0) * getPct(c), 0);
                const costInStock = inStock.reduce((s,c) => s + c.buyPrice * getPct(c), 0);
                const costSold    = sold.reduce((s,c)   => s + c.buyPrice * getPct(c), 0);
                const revenue     = sold.reduce((s,c)   => s + (c.salePrice||0) * getPct(c), 0);
                const profit      = revenue - costSold;
                const totalInvested = costInStock + costSold;
                const unrealized  = equity - costInStock;
                return { ...p, equity, costInStock, costSold, revenue, profit, totalInvested, unrealized, cardCount: inStock.length + sold.length };
              });

              return (
                <div style={{marginTop:20}}>
                  <div style={{fontSize:9,color:"#555",letterSpacing:2,textTransform:"uppercase",marginBottom:12}}>Partner Equity Breakdown</div>
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    {partnerStats.map(p => (
                      <div key={p.id} style={{padding:16,background:"#0e0e18",border:`1px solid ${p.color}33`,borderRadius:6,borderLeft:`3px solid ${p.color}`}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                          <div style={{width:28,height:28,borderRadius:"50%",background:p.color+"22",border:`2px solid ${p.color}`,
                            display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:p.color}}>
                            {p.initials || p.name.slice(0,2).toUpperCase()}
                          </div>
                          <span style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:15,color:"#e8e4d9",letterSpacing:1}}>{p.name}</span>
                          <span style={{fontSize:10,color:"#555",marginLeft:4}}>{p.cardCount} cards</span>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:8}}>
                          {[
                            {l:"Portfolio Equity",   v:fmt(p.equity),                                  c:p.color},
                            {l:"Total Invested",     v:fmt(p.totalInvested),                           c:"#f87171"},
                            {l:"Unrealized Gain",    v:(p.unrealized>=0?"+":"-")+fmt(p.unrealized),    c:p.unrealized>=0?"#4ade80":"#f87171"},
                            {l:"Revenue (Sales)",    v:fmt(p.revenue),                                 c:"#4ade80"},
                            {l:"Cost of Sold",       v:fmt(p.costSold||0),                             c:"#f87171"},
                            {l:"Realized Profit",    v:(p.profit>=0?"+":"-")+fmt(p.profit),            c:p.profit>=0?"#4ade80":"#f87171"},
                          ].map(s => (
                            <div key={s.l} style={{background:"#0a0a12",border:"1px solid #1a1a28",borderRadius:4,padding:"8px 10px"}}>
                              <div style={{fontSize:8,letterSpacing:1.5,color:"#555",textTransform:"uppercase",marginBottom:4}}>{s.l}</div>
                              <div style={{fontFamily:"'Black Han Sans',sans-serif",fontSize:14,color:s.c}}>{s.v}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* ═══ ADD CARD MODAL ═══ */}
      {showAddCard && (
        <ModalShell title="ADD CARD TO INVENTORY" onClose={()=>setShowAddCard(false)}>
          <form onSubmit={handleAddCard}>
            {/* 1. Date + Notes */}
            <div className="grid2" style={{marginBottom:14}}>
              <div>
                <label>Purchase Date</label>
                <input className="input" type="date" value={addCardDate} onChange={e=>setAddCardDate(e.target.value)}/>
              </div>
              <div>
                <label>Notes {defaultNote&&<span style={{color:"#f5a623",marginLeft:4}}>· default: "{defaultNote}"</span>}</label>
                <input className="input" value={addCardNotes} onChange={e=>setAddCardNotes(e.target.value)} placeholder={defaultNote||"e.g. collection buyout"}/>
              </div>
            </div>
            {/* 2. Card Name */}
            <div style={{marginBottom:14}}>
              <AltLookup onResult={r=>setNewCard(p=>({...p,name:r.cardName}))}/>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <label style={{margin:0}}>Card Name</label>
                {(newCard.name||newCard.buyPrice||newCard.marketAtPurchase)&&(
                  <button type="button" onClick={()=>setNewCard(BLANK_CARD)}
                    style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",
                      background:"transparent",color:"#555",border:"1px solid #252535",
                      fontFamily:"'Space Mono',monospace"}}>
                    ✕ clear fields
                  </button>
                )}
              </div>
              <input className="input" required value={newCard.name} onChange={e=>setNewCard(p=>({...p,name:e.target.value}))} placeholder="e.g. Charizard ex"/>
            </div>
            {/* 3. Grade + Pricing */}
            <div style={{marginBottom:14,padding:14,background:"#0c0c18",borderRadius:4,border:"1px solid #1a1a2e"}}>
              <GradeFields data={newCard} onChange={setNewCard}/>
            </div>
            <div style={{marginBottom:14}}><PricingFields data={newCard} onChange={setNewCard}/></div>
            {/* 4. Summary pill */}
            {newCard.buyPrice&&newCard.marketAtPurchase&&toF(newCard.marketAtPurchase)>0&&(()=>{
              const ip=(toF(newCard.buyPrice)/toF(newCard.marketAtPurchase))*100;
              const margin=toF(newCard.currentMarketTouched?newCard.currentMarket:newCard.marketAtPurchase)-toF(newCard.buyPrice);
              return<div style={{marginBottom:14,padding:10,background:"#0a0a0f",border:"1px solid #1a1a28",borderRadius:3,fontSize:12,display:"flex",gap:16,flexWrap:"wrap"}}>
                <span style={{color:"#555"}}>Intake: <span className={`pct-pill ${pillCls(ip)}`}>{pct(ip)}</span></span>
                <span style={{color:"#555"}}>Margin: <span className={margin>=0?"profit":"loss"}>{margin>=0?"+":"-"}{fmt(margin)}</span></span>
              </div>;
            })()}
            {/* 5. Payment → 6. Ownership → 7. Photo */}
            {(()=>{
              const missing = [];
              if (!newCard.name.trim()) missing.push("card name");
              if (!(toF(newCard.buyPrice) > 0)) missing.push("buy price");
              if (!(toF(newCard.marketAtPurchase) > 0)) missing.push("market @ purchase");
              const canAdd = missing.length === 0;
              return (
                <>
                  <BuyPaymentUI payment={addCardPayment} onChange={setAddCardPayment} buyPrice={toF(newCard.buyPrice)}/>
                  <OwnershipSplit profiles={profiles} owners={addCardOwners} onChange={setAddCardOwners}/>
                  <div style={{marginTop:14}}>
                    <ImagePicker value={addCardImage} onChange={setAddCardImage} label="Transaction Photo (optional)"/>
                  </div>
                  {!canAdd && (
                    <div style={{marginTop:10,marginBottom:10,padding:"8px 12px",background:"#1a0a0a",border:"1px solid #7f1d1d44",borderRadius:3,fontSize:11,color:"#f87171"}}>
                      ⚠ Required: {missing.join(", ")}
                    </div>
                  )}
                  <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:10}}>
                    <button type="button" className="btn btn-ghost" onClick={()=>setShowAddCard(false)}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={!canAdd} style={{opacity:canAdd?1:0.4,cursor:canAdd?"pointer":"not-allowed"}}>Add to Inventory</button>
                  </div>
                </>
              );
            })()}
          </form>
        </ModalShell>
      )}

      {/* ═══ BATCH BUY MODAL ═══ */}
      {showBatch && (
        <ModalShell title="BATCH PURCHASE" onClose={()=>setShowBatch(false)} wide>
          {/* 1. Date + Notes */}
          <div className="grid2" style={{marginBottom:14}}>
            <div><label>Purchase Date</label><input className="input" type="date" value={batchDate} onChange={e=>setBatchDate(e.target.value)}/></div>
            <div><label>Notes</label><input className="input" value={batchNotes} onChange={e=>setBatchNotes(e.target.value)} placeholder={defaultNote||"e.g. Collection buyout"}/></div>
          </div>

          {/* 2. Add Card to Batch (always on top) */}
          <div style={{padding:14,background:"#0c0c18",borderRadius:4,border:"1px solid #1a1a2e",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontSize:9,color:"#f5a623",letterSpacing:1.5,textTransform:"uppercase"}}>Add Card to Batch</div>
              {(batchDraft.name||batchDraft.buyPrice||batchDraft.marketAtPurchase)&&(
                <button type="button" onClick={()=>{ setBatchDraft(BLANK_CARD); setBatchDraftQty("1"); }}
                  style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",
                    background:"transparent",color:"#555",border:"1px solid #252535",
                    fontFamily:"'Space Mono',monospace",whiteSpace:"nowrap"}}>
                  ✕ clear fields
                </button>
              )}
            </div>
            <AltLookup onResult={r=>setBatchDraft(p=>({...p,name:r.cardName}))}/>
            <div className="grid2" style={{marginBottom:10}}>
              <div>
                <label>Card Name</label>
                <input className="input" value={batchDraft.name}
                  onChange={e=>setBatchDraft(p=>({...p,name:e.target.value}))}
                  onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();handleStageBatchCard();}}}
                  placeholder="Press Enter to stage"/>
              </div>
              <div><label>Qty</label><input className="input" type="number" min="1" step="1" value={batchDraftQty} onChange={e=>setBatchDraftQty(e.target.value)}/></div>
            </div>
            <div style={{marginBottom:10}}><GradeFields data={batchDraft} onChange={setBatchDraft}/></div>
            <div style={{marginBottom:10}}><PricingFields data={batchDraft} onChange={setBatchDraft}/></div>
            <button className="btn btn-ghost" style={{width:"100%"}} onClick={handleStageBatchCard}>+ Stage Card</button>
          </div>

          {/* 3. Staged cards — always-visible pro-rata style display */}
          {batchCards.length>0 && (()=>{
            const totalCost = batchCards.reduce((s,c)=>s+c.buyPrice*(c.qty||1),0);
            const totalMkt  = batchCards.reduce((s,c)=>s+((c.currentMarket||c.marketAtPurchase||0)*(c.qty||1)),0);
            const finalRef  = toF(batchFinalPurchase)>0 ? toF(batchFinalPurchase) : totalCost;
            const mktForRef = totalMkt > 0 ? totalMkt : totalCost;
            return (
              <div style={{marginBottom:14,padding:12,background:"#0a0a0f",border:"1px solid #1a1a28",borderRadius:4}}>
                {/* Final price override row */}
                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:10}}>
                  <div style={{fontSize:9,color:"#555",letterSpacing:1.5,textTransform:"uppercase",flexShrink:0}}>
                    Final Purchase Price
                  </div>
                  <input className="input" type="number" min="0" step="0.01"
                    style={{width:120,padding:"4px 8px",fontSize:11}}
                    value={batchFinalPurchase}
                    onChange={e=>setBatchFinalPurchase(e.target.value)}
                    placeholder={totalCost.toFixed(2)}/>
                  <span style={{fontSize:10,color:"#555"}}>
                    {toF(batchFinalPurchase)>0?"pro-rata override":"sum:"} <span style={{color:"#e8e4d9"}}>{fmt(finalRef)}</span>
                    <span style={{marginLeft:8,color:"#4ade80"}}>mkt {fmt(totalMkt)}</span>
                  </span>
                </div>
                {/* Per-card breakdown */}
                <div style={{fontSize:9,color:"#555",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>
                  Staged — {batchCards.length} {batchCards.length===1?"entry":"entries"}
                </div>
                {batchCards.map((c,i)=>{
                  const qty       = c.qty||1;
                  const mktUnit   = c.currentMarket||c.marketAtPurchase||0;
                  const allocUnit = mktForRef>0 ? (mktUnit/mktForRef)*finalRef : c.buyPrice;
                  const ip        = mktUnit>0 ? (allocUnit/mktUnit)*100 : null;
                  return (
                    <div key={i} className="prev-row" style={{fontSize:11,flexWrap:"wrap",gap:"3px 8px"}}>
                      <span style={{color:"#e8e4d9",fontWeight:600}}>
                        {toTitleCase(c.name)}
                        {c.qty>1&&<span style={{marginLeft:6,color:"#f5a623"}}>×{qty}</span>}
                        {c.isGraded&&c.grade&&<span style={{fontSize:10,color:"#a78bfa",marginLeft:6}}>{c.grade}</span>}
                      </span>
                      <span style={{display:"flex",gap:8,alignItems:"center"}}>
                        <span style={{color:"#e8e4d9",fontWeight:700}}>{fmt(allocUnit*qty)}</span>
                        {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`}>{pct(ip)}</span>}
                        <span style={{color:"#555",fontSize:10}}>mkt {fmt(mktUnit*qty)}</span>
                        <button className="btn btn-ghost btn-sm" style={{padding:"2px 8px",fontSize:10}} onClick={()=>{
                          setBatchDraft({...c, buyPrice:String(c.buyPrice), marketAtPurchase:String(c.marketAtPurchase), currentMarket:String(c.currentMarket||"")});
                          setBatchDraftQty(String(c.qty||1));
                          setBatchCards(p=>p.filter((_,j)=>j!==i));
                        }}>✎</button>
                        <button className="btn btn-danger btn-sm" onClick={()=>setBatchCards(p=>p.filter((_,j)=>j!==i))}>✕</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* 4. Payment → 5. Ownership → 6. Photo */}
          {(()=>{
            const totalCost = batchCards.reduce((s,c)=>s+c.buyPrice*(c.qty||1),0);
            const effectiveBuyPrice = toF(batchFinalPurchase)>0 ? toF(batchFinalPurchase) : totalCost;
            return (
              <>
                <BuyPaymentUI payment={batchPayment} onChange={setBatchPayment} buyPrice={effectiveBuyPrice}/>
                <OwnershipSplit profiles={profiles} owners={batchOwners} onChange={setBatchOwners}/>
                <div style={{marginTop:14}}>
                  <ImagePicker value={batchImage} onChange={setBatchImage} label="Transaction Photo (optional)"/>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end",alignItems:"center",marginTop:10}}>
                  {!batchCards.length && (
                    <span style={{fontSize:11,color:"#555",marginRight:4}}>⚠ Stage at least one card first</span>
                  )}
                  <button className="btn btn-ghost" onClick={()=>setShowBatch(false)}>Cancel</button>
                  <button className="btn btn-primary" style={{opacity:batchCards.length?1:0.4,cursor:batchCards.length?"pointer":"not-allowed"}} onClick={handleCommitBatch} disabled={!batchCards.length}>
                    Add {batchCards.length} Card{batchCards.length!==1?"s":""} to Inventory
                  </button>
                </div>
              </>
            );
          })()}
        </ModalShell>
      )}

      {/* ═══ TRANSACTION MODAL ═══ */}
      {showAddTx && (
        <ModalShell title="NEW TRANSACTION" onClose={()=>setShowAddTx(false)}>
          <div style={{display:"flex",gap:8,marginBottom:18}}>
            {["sale","trade"].map(t=>(
              <button key={t} className={`tx-type-btn ${txType===t?"active":""}`} onClick={()=>setTxType(t)}>
                {t==="sale"?"💰 Sale":"⇄ Trade"}
              </button>
            ))}
          </div>
          <div className="grid2" style={{marginBottom:14}}>
            <div><label>Date</label><input className="input" type="date" value={txDate} onChange={e=>setTxDate(e.target.value)}/></div>
            <div>
              <label>Notes {defaultNote&&<span style={{color:"#f5a623",marginLeft:4}}>· default: "{defaultNote}"</span>}</label>
              <input className="input" value={txNotes} onChange={e=>setTxNotes(e.target.value)} placeholder={defaultNote||"e.g. local event"}/>
              {defaultNote&&!txNotes&&<div style={{fontSize:9,color:"#555",marginTop:3}}>Leave blank to use default</div>}
            </div>
          </div>

          {/* Cards Out */}
          <div style={{marginBottom:14}}>
            <label style={{color:"#f87171",marginBottom:6}}>Your Cards Going Out</label>
            {inStockCards.length>0 && (
              <div style={{marginBottom:6}}>
                <input className="input" style={{width:"100%",maxWidth:260,fontSize:11,padding:"6px 10px"}}
                  placeholder={txType==="trade"?"Search cards to trade...":"Search cards to sell..."}
                  value={txCardSearch} onChange={e=>setTxCardSearch(e.target.value)}/>
              </div>
            )}
            {inStockCards.length===0
              ? <div style={{fontSize:12,color:"#444"}}>No cards in stock.</div>
              : <div style={{maxHeight:txType==="trade"?260:180,overflowY:"auto",display:"flex",flexDirection:"column",gap:3,paddingRight:4}}>
                  {(()=>{
                    const term = txCardSearch.trim().toLowerCase();
                    const selectedIds = new Set(txCardsOut.map(c=>c.id));
                    const filtered = inStockCards.filter(card =>
                      !term ||
                      (card.name||"").toLowerCase().includes(term) ||
                      (card.grade||"").toLowerCase().includes(term) ||
                      (card.condition||"").toLowerCase().includes(term)
                    );
                    return filtered
                      .sort((a,b) => (selectedIds.has(b.id)?1:0)-(selectedIds.has(a.id)?1:0))
                      .map(card => {
                        const sel     = !!txCardsOut.find(c=>c.id===card.id);
                        const selCard = txCardsOut.find(c=>c.id===card.id);
                        const ip      = card.marketAtPurchase>0 ? (card.buyPrice/card.marketAtPurchase)*100 : null;
                        const pctPresets = [100,95,90,85,80,75,70];
                        return (
                          <div key={card.id}>
                            <div className={`cb-card ${sel?"sel":""}`} onClick={()=>toggleCardOut(card)}>
                              <span style={{fontSize:13}}>{sel?"☑":"☐"}</span>
                              <span style={{flex:1,textTransform:"capitalize",fontSize:13,fontWeight:600}}>{card.name}</span>
                              <GradeTag card={card} small/>
                              {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`} style={{marginLeft:6}}>in {pct(ip)}</span>}
                              <span style={{color:"#f5a623",marginLeft:6,fontWeight:700}}>{fmt(card.currentMarket||0)}</span>
                            </div>
                            {sel&&selCard&&(
                              <div style={{padding:"8px 10px 8px 26px",
                                background:txType==="trade"?"#0c0a18":"#0a0c0a",
                                borderLeft:txType==="trade"?"2px solid #fb923c44":"2px solid #4ade8044",marginBottom:2}}>
                                {/* Card cost info row */}
                                <div style={{display:"flex",gap:12,marginBottom:7,fontSize:11,flexWrap:"wrap",alignItems:"center"}}>
                                  <span style={{color:"#555"}}>bought <span style={{color:"#e8e4d9",fontWeight:700}}>{fmt(card.buyPrice)}</span></span>
                                  {card.marketAtPurchase>0&&<span style={{color:"#555"}}>mkt @ buy <span style={{color:"#aaa"}}>{fmt(card.marketAtPurchase)}</span></span>}
                                  {ip!=null&&<span className={`pct-pill ${pillCls(ip)}`}>in {pct(ip)}</span>}
                                  <span style={{color:"#555"}}>current mkt <span style={{color:"#f5a623",fontWeight:700}}>{fmt(card.currentMarket||0)}</span></span>
                                </div>
                                {/* Price input + tappable % pill */}
                                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                                  <span style={{fontSize:10,color:"#777",flexShrink:0}}>
                                    {txType==="trade"?"Agreed value ($)":"Sell at ($)"}
                                  </span>
                                  <input className="input" type="number" min="0" step="0.01"
                                    style={{width:110,padding:"3px 8px",fontSize:12}}
                                    value={selCard.tradedAtPrice??""} onClick={e=>e.stopPropagation()}
                                    onChange={e=>{e.stopPropagation();updateCardOutTradedAt(card.id,e.target.value);}}
                                    placeholder={`${fmt(card.currentMarket||0)} (100%)`}/>
                                  {card.currentMarket>0&&(()=>{
                                    const raw = toF(selCard.tradedAtPrice);
                                    const activePct = raw>0 ? Math.round((raw/card.currentMarket)*100) : 100;
                                    const cls = salePillCls(activePct);
                                    return (
                                      <span
                                        className={`pct-pill ${cls}`}
                                        onClick={e=>{
                                          e.stopPropagation();
                                          const idx = pctPresets.indexOf(activePct);
                                          const next = pctPresets[(idx+1)%pctPresets.length];
                                          updateCardOutTradedAt(card.id,((next/100)*card.currentMarket).toFixed(2));
                                        }}
                                        style={{cursor:"pointer",fontSize:9,userSelect:"none",flexShrink:0,padding:"2px 8px"}}
                                        title="Tap to cycle % presets">
                                        {activePct}% mkt ↻
                                      </span>
                                    );
                                  })()}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      });
                  })()}
                </div>
            }
            {txCardsOut.length>0&&(
              <div style={{fontSize:11,color:"#888",marginTop:6,display:"flex",gap:12,flexWrap:"wrap"}}>
                <span>{txCardsOut.length} card(s) · market {fmt(totalMktOut)}</span>
                {txType==="trade"&&<span style={{color:"#fb923c"}}>· agreed {fmt(txCardsOut.reduce((s,c)=>s+(toF(c.tradedAtPrice)||c.currentMarket||0),0))}</span>}
              </div>
            )}
          </div>

          {/* Trade-ins */}
          {txType==="trade"&&(
            <div style={{marginBottom:14,padding:14,background:"#0c0c18",borderRadius:4,border:"1px solid #1a1a2e"}}>
              <label style={{color:"#4ade80",marginBottom:8}}>Their Cards Coming In</label>
              {txCardsIn.length>0&&<div style={{marginBottom:10}}>
                {txCardsIn.map((c,i)=>{
                  const pctPresets = [100,95,90,85,80,75,70];
                  const activePct  = c.currentMarket>0 && toF(c.tradedAtPrice)>0
                    ? Math.round((toF(c.tradedAtPrice)/c.currentMarket)*100) : 100;
                  return (
                    <div key={i} style={{padding:"8px 10px",background:"#0a0a12",borderRadius:3,border:"1px solid #1a1a2a",marginBottom:6}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <span style={{fontSize:12,color:"#4ade80",fontWeight:600}}>
                          {c.name}{c.isGraded&&c.grade&&<span style={{fontSize:10,color:"#a78bfa",marginLeft:6}}>{c.grade}</span>}
                        </span>
                        <div style={{display:"flex",gap:4}}>
                          <button className="btn btn-ghost btn-sm" style={{padding:"2px 8px",fontSize:10}} onClick={()=>{
                            setNewTradeCard({...c, buyPrice:String(c.buyPrice||""), marketAtPurchase:String(c.marketAtPurchase||""), currentMarket:String(c.currentMarket||""), currentMarketTouched:!!(c.currentMarket)});
                            setTxCardsIn(p=>p.filter((_,j)=>j!==i));
                          }}>✎</button>
                          <button className="btn btn-danger btn-sm" onClick={()=>setTxCardsIn(p=>p.filter((_,j)=>j!==i))}>✕</button>
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        <span style={{fontSize:10,color:"#555",flexShrink:0}}>mkt {fmt(c.currentMarket||0)}</span>
                        <span style={{fontSize:10,color:"#777",flexShrink:0}}>agreed ($)</span>
                        <input className="input" type="number" min="0" step="0.01"
                          style={{width:100,padding:"3px 8px",fontSize:12}}
                          value={c.tradedAtPrice??""} placeholder={fmt(c.currentMarket||0)}
                          onChange={e=>setTxCardsIn(p=>p.map((x,j)=>j===i?{...x,tradedAtPrice:e.target.value}:x))}/>
                        {c.currentMarket>0&&(
                          <span
                            className={`pct-pill ${salePillCls(activePct)}`}
                            onClick={()=>{
                              const idx  = pctPresets.indexOf(activePct);
                              const next = pctPresets[(idx+1)%pctPresets.length];
                              setTxCardsIn(p=>p.map((x,j)=>j===i?{...x,tradedAtPrice:((next/100)*c.currentMarket).toFixed(2)}:x));
                            }}
                            style={{cursor:"pointer",fontSize:9,userSelect:"none",flexShrink:0,padding:"2px 8px"}}>
                            {activePct}% mkt ↻
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>}
              <div style={{padding:12,background:"#0a0a12",borderRadius:3,border:"1px solid #1a1a2a"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontSize:9,color:"#4ade80",letterSpacing:1.5,textTransform:"uppercase"}}>Add Card</span>
                  {(newTradeCard.name||newTradeCard.buyPrice||newTradeCard.marketAtPurchase)&&(
                    <button type="button" onClick={()=>setNewTradeCard(BLANK_CARD)}
                      style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",
                        background:"transparent",color:"#555",border:"1px solid #252535",
                        fontFamily:"'Space Mono',monospace",whiteSpace:"nowrap"}}>
                      ✕ clear fields
                    </button>
                  )}
                </div>
                <AltLookup onResult={r=>setNewTradeCard(p=>({...p,name:r.cardName}))}/>
                <div style={{marginBottom:8}}>
                  <input className="input" style={{width:"100%"}} placeholder="Card name" value={newTradeCard.name} onChange={e=>setNewTradeCard(p=>({...p,name:e.target.value}))}/>
                </div>
                <div style={{marginBottom:10}}><GradeFields data={newTradeCard} onChange={setNewTradeCard}/></div>
                <div style={{marginBottom:8}}><PricingFields data={newTradeCard} onChange={setNewTradeCard}/></div>
                <button className="btn btn-ghost" style={{width:"100%"}} onClick={handleAddTradeCard}>+ Add Card to Trade</button>
              </div>
              <OwnershipSplit profiles={profiles} owners={txInOwners} onChange={setTxInOwners}/>
            </div>
          )}


          {/* ── PRO-RATA: Cards Out ─────────────────────────────── */}
          {(txType==="sale"||txType==="trade") && txCardsOut.length>0 && (
            <div style={{marginBottom:14,padding:12,background:"#0a0a0f",border:"1px solid #1e1e28",borderRadius:4}}>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:8}}>
                <div style={{fontSize:9,color:"#f87171",letterSpacing:1.5,textTransform:"uppercase",flexShrink:0}}>
                  {txType==="sale"?"Your Sale Price (out)":"Your Cards Value (out)"}
                </div>
                <input className="input" type="number" min="0" step="0.01"
                  style={{width:120,padding:"4px 8px",fontSize:11}}
                  value={txFinalPrice}
                  onChange={e=>setTxFinalPrice(e.target.value)}
                  placeholder={cardsSaleSum>0?cardsSaleSum.toFixed(2):"total override"}/>
                <span style={{fontSize:10,color:"#555"}}>
                  {toF(txFinalPrice)>0?"pro-rata override":"per-card sum:"} <span style={{color:"#e8e4d9"}}>{fmt(toF(txFinalPrice)>0?toF(txFinalPrice):cardsSaleSum)}</span>
                </span>
              </div>
              {/* Always-visible breakdown */}
              {txCardsOut.map((co,i)=>{
                const ref   = toF(txFinalPrice)>0 ? toF(txFinalPrice) : null;
                const alloc = ref!=null ? (totalMktOut>0?(co.currentMarket/totalMktOut)*ref:0) : (toF(co.tradedAtPrice)||co.currentMarket||0);
                const sp    = co.currentMarket>0?(alloc/co.currentMarket)*100:0;
                return <div key={i} className="prev-row" style={{fontSize:11}}>
                  <span style={{color:"#aaa"}}>{toTitleCase(co.name)}{co.grade&&<span style={{fontSize:10,color:"#a78bfa",marginLeft:6}}>{co.grade}</span>}</span>
                  <span style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{color:"#e8e4d9",fontWeight:700}}>{fmt(alloc)}</span>
                    <span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>
                  </span>
                </div>;
              })}
            </div>
          )}

          {/* ── PRO-RATA: Cards In (trade only) ──────────────────── */}
          {txType==="trade" && txCardsIn.length>0 && (
            <div style={{marginBottom:14,padding:12,background:"#0a0a0f",border:"1px solid #1e1e28",borderRadius:4}}>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:8}}>
                <div style={{fontSize:9,color:"#4ade80",letterSpacing:1.5,textTransform:"uppercase",flexShrink:0}}>
                  Their Cards Value (in)
                </div>
                <input className="input" type="number" min="0" step="0.01"
                  style={{width:120,padding:"4px 8px",fontSize:11}}
                  value={txInFinalPrice}
                  onChange={e=>setTxInFinalPrice(e.target.value)}
                  placeholder={totalMktIn>0?totalMktIn.toFixed(2):"total override"}/>
                <span style={{fontSize:10,color:"#555"}}>
                  {toF(txInFinalPrice)>0?"pro-rata override":"per-card sum:"} <span style={{color:"#e8e4d9"}}>{fmt(toF(txInFinalPrice)>0?toF(txInFinalPrice):totalMktIn)}</span>
                </span>
              </div>
              {txCardsIn.map((ci,i)=>{
                const ref   = toF(txInFinalPrice)>0 ? toF(txInFinalPrice) : null;
                const base  = toF(ci.tradedAtPrice)||toF(ci.currentMarket)||toF(ci.marketAtPurchase)||0;
                const alloc = ref!=null ? (totalMktIn>0?(base/totalMktIn)*ref:0) : base;
                const mkt   = toF(ci.currentMarket)||toF(ci.marketAtPurchase)||0;
                const sp    = mkt>0?(alloc/mkt)*100:0;
                return <div key={i} className="prev-row" style={{fontSize:11}}>
                  <span style={{color:"#aaa"}}>{toTitleCase(ci.name)}{ci.grade&&<span style={{fontSize:10,color:"#a78bfa",marginLeft:6}}>{ci.grade}</span>}</span>
                  <span style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{color:"#e8e4d9",fontWeight:700}}>{fmt(alloc)}</span>
                    {sp>0&&<span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>}
                  </span>
                </div>;
              })}
            </div>
          )}

          {/* ── TRADE BALANCE ──────────────────────────────────────── */}
          {txType==="trade" && txCardsOut.length>0 && txCardsIn.length>0 && (()=>{
            const myVal    = toF(txFinalPrice)>0 ? toF(txFinalPrice)
              : txCardsOut.reduce((s,c)=>s+(toF(c.tradedAtPrice)||c.currentMarket||0),0);
            const theirVal = toF(txInFinalPrice)>0 ? toF(txInFinalPrice)
              : txCardsIn.reduce((s,c)=>s+(toF(c.tradedAtPrice)||toF(c.currentMarket)||toF(c.marketAtPurchase)||0),0);
            const rawDiff  = myVal - theirVal; // >0 = they owe us, <0 = we owe them
            return (
              <div style={{marginBottom:14,padding:10,background:"#0a0a0f",border:"1px solid #fb923c33",borderRadius:3}}>
                <div style={{fontSize:9,color:"#fb923c",letterSpacing:1.5,textTransform:"uppercase",marginBottom:6}}>Trade Balance</div>
                <div style={{display:"flex",gap:16,flexWrap:"wrap",fontSize:11,marginBottom:6}}>
                  <span style={{color:"#555"}}>Your cards: <span style={{color:"#f87171",fontWeight:700}}>{fmt(myVal)}</span></span>
                  <span style={{color:"#555"}}>Their cards: <span style={{color:"#4ade80",fontWeight:700}}>{fmt(theirVal)}</span></span>
                </div>
                <div style={{fontSize:12,fontWeight:700,color:Math.abs(rawDiff)<0.005?"#555":rawDiff>0?"#4ade80":"#f87171"}}>
                  {Math.abs(rawDiff)<0.005?"Even trade"
                    :rawDiff>0?`They owe you ${fmt(rawDiff)}`
                    :`You owe ${fmt(Math.abs(rawDiff))}`}
                </div>
              </div>
            );
          })()}

          {/* ── PAYMENT METHOD (unified design) ────────────────────── */}
          <div style={{marginBottom:14}}>
            <label style={{marginBottom:8}}>Payment Method</label>
            {(()=>{
              // Compute reference total for auto-fill
              // Sale: total received; Trade: raw trade balance → direction + amount
              const myVal    = txType==="trade" ? (toF(txFinalPrice)>0?toF(txFinalPrice):txCardsOut.reduce((s,c)=>s+(toF(c.tradedAtPrice)||c.currentMarket||0),0)) : 0;
              const theirVal = txType==="trade" ? (toF(txInFinalPrice)>0?toF(txInFinalPrice):txCardsIn.reduce((s,c)=>s+(toF(c.tradedAtPrice)||toF(c.currentMarket)||toF(c.marketAtPurchase)||0),0)) : 0;
              const tradeDiff  = myVal - theirVal; // >0 = they owe, <0 = we owe
              const tradeAmt   = Math.abs(tradeDiff);
              const tradeDir   = tradeDiff >= 0 ? "in" : "out"; // which direction auto should fill
              const saleRef    = txType==="sale" ? (toF(txFinalPrice)>0?toF(txFinalPrice):cardsSaleSum) : 0;

              const methods     = txPaymentMethods;
              const amtKey      = {cash:"txCashAmt",venmo:"txVenmoAmount",zelle:"txZelleAmount"};
              const dirState    = {cash:txCashDir, venmo:txVenmoDir, zelle:txZelleDir};
              const valState    = {cash:txCashAmt, venmo:txVenmoAmount, zelle:txZelleAmount};
              const color       = {cash:"#4ade80",venmo:"#60a5fa",zelle:"#c084fc"};
              const icon        = {cash:"💵",venmo:"💙",zelle:"💜"};
              const setDir      = {cash:setTxCashDir,venmo:setTxVenmoDir,zelle:setTxZelleDir};
              const setAmt      = {cash:setTxCashAmt,venmo:setTxVenmoAmount,zelle:setTxZelleAmount};

              // Compute auto amount per empty slot
              let autoAmt = null, autoDir = "in";
              if (txType==="trade" && tradeAmt>0.005) {
                autoDir = tradeDir;
                const filledMatch = methods.reduce((s,m)=>s+(dirState[m]===tradeDir&&valState[m]?parseFloat(valState[m])||0:0),0);
                const emptyMatch  = methods.filter(m=>dirState[m]===tradeDir&&!valState[m]).length;
                if (emptyMatch>0) autoAmt = parseFloat((Math.max(0,tradeAmt-filledMatch)/emptyMatch).toFixed(2));
              } else if (txType==="sale" && saleRef>0) {
                autoDir = "in";
                const filledIn = methods.reduce((s,m)=>s+(dirState[m]==="in"&&valState[m]?parseFloat(valState[m])||0:0),0);
                const emptyIn  = methods.filter(m=>dirState[m]==="in"&&!valState[m]).length;
                if (emptyIn>0) autoAmt = parseFloat((Math.max(0,saleRef-filledIn)/emptyIn).toFixed(2));
              }

              const showAutoFor = m => autoAmt!=null && dirState[m]===autoDir && !valState[m];

              // Running total
              const ci  = methods.includes("cash") ? (txCashDir==="in"?toF(txCashAmt):0) : 0;
              const co  = methods.includes("cash") ? (txCashDir==="out"?toF(txCashAmt):0) : 0;
              const vi  = methods.includes("venmo") ? (txVenmoDir==="in"?toF(txVenmoAmount):0) : 0;
              const vo  = methods.includes("venmo") ? (txVenmoDir==="out"?toF(txVenmoAmount):0) : 0;
              const zi  = methods.includes("zelle") ? (txZelleDir==="in"?toF(txZelleAmount):0) : 0;
              const zo  = methods.includes("zelle") ? (txZelleDir==="out"?toF(txZelleAmount):0) : 0;
              const totalIn=ci+vi+zi, totalOut=co+vo+zo;

              return (
                <>
                  {/* Method toggles */}
                  <div style={{display:"flex",gap:6,marginBottom:methods.length?10:0}}>
                    {[["cash","💵 Cash"],["venmo","💙 Venmo"],["zelle","💜 Zelle"]].map(([m,label])=>{
                      const sel = methods.includes(m);
                      return (
                        <button key={m} type="button"
                          onClick={()=>setTxPaymentMethods(prev=>sel?prev.filter(x=>x!==m):[...prev,m])}
                          style={{flex:1,padding:"8px 6px",borderRadius:3,cursor:"pointer",
                            fontFamily:"'Space Mono',monospace",fontSize:11,transition:"all 0.15s",
                            background:sel?color[m]+"22":"transparent",color:sel?color[m]:"#555",
                            border:`1px solid ${sel?color[m]+"55":"#252535"}`}}>
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Per-method rows */}
                  {methods.map(m=>(
                    <div key={m} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                      <span style={{fontSize:11,color:color[m],width:22,flexShrink:0,textAlign:"center"}}>{icon[m]}</span>
                      <button type="button" onClick={()=>setDir[m](d=>d==="out"?"in":"out")}
                        style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",flexShrink:0,
                          background:dirState[m]==="out"?"#f8717122":"#4ade8022",
                          color:dirState[m]==="out"?"#f87171":"#4ade80",
                          border:"1px solid transparent",fontFamily:"'Space Mono',monospace"}}>
                        {dirState[m]==="out"?"↑ Out":"↓ In"}
                      </button>
                      <input className="input" type="number" min="0" step="0.01"
                        value={valState[m]}
                        onChange={e=>setAmt[m](e.target.value)}
                        placeholder={showAutoFor(m)?`auto ${autoAmt.toFixed(2)}`:"amount"}
                        style={{flex:1,padding:"3px 8px",fontSize:12,
                          borderColor:valState[m]?"":color[m]+"33"}}/>
                      {showAutoFor(m)&&(
                        <button type="button" onClick={()=>setAmt[m](autoAmt.toFixed(2))}
                          style={{padding:"2px 8px",borderRadius:3,fontSize:10,cursor:"pointer",flexShrink:0,
                            background:color[m]+"22",color:color[m],border:`1px solid ${color[m]}44`,
                            fontFamily:"'Space Mono',monospace",whiteSpace:"nowrap"}}>
                          ✓ {autoAmt.toFixed(2)}
                        </button>
                      )}
                    </div>
                  ))}

                  {/* Running total strip */}
                  {(totalIn>0||totalOut>0)&&(
                    <div style={{marginTop:4,padding:"6px 10px",background:"#0a0a12",border:"1px solid #1e1e28",borderRadius:3,display:"flex",gap:16,fontSize:11,flexWrap:"wrap"}}>
                      {totalIn>0&&<span style={{color:"#4ade80"}}>In: <strong>{fmt(totalIn)}</strong></span>}
                      {totalOut>0&&<span style={{color:"#f87171"}}>Out: <strong>{fmt(totalOut)}</strong></span>}
                      {totalIn>0&&totalOut>0&&<span style={{color:totalIn-totalOut>=0?"#4ade80":"#f87171"}}>Net: <strong>{totalIn-totalOut>=0?"+":""}{fmt(totalIn-totalOut)}</strong></span>}
                      {txType==="sale"&&saleRef>0&&totalIn>0&&Math.abs(totalIn-saleRef)>0.005&&(
                        <span style={{color:totalIn>saleRef?"#f5a623":"#f87171",marginLeft:"auto",fontSize:10}}>
                          {totalIn>saleRef?`+${fmt(totalIn-saleRef)} over`:`${fmt(saleRef-totalIn)} under`} target
                        </span>
                      )}
                      {txType==="trade"&&tradeAmt>0.005&&Math.abs(totalIn-totalOut-tradeDiff*(tradeDiff>0?1:-1)*-1)>0.005&&null}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Batch sale allocation — always shown for sale with multiple cards */}
          {txType==="sale"&&txCardsOut.length>1&&(()=>{
            const saleRef = toF(txFinalPrice)>0?toF(txFinalPrice):(cashInVal>0?cashInVal:cardsSaleSum);
            if (saleRef<=0) return null;
            return (
              <div style={{marginBottom:14,padding:12,background:"#0a0a0f",border:"1px solid #1a1a28",borderRadius:4}}>
                <div style={{fontSize:9,color:"#555",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8}}>Per-Card Sale Allocation</div>
                {txCardsOut.map((co,i)=>{
                  const alloc = totalMktOut>0?(co.currentMarket/totalMktOut)*saleRef:0;
                  const sp    = co.currentMarket>0?(alloc/co.currentMarket)*100:0;
                  return <div key={i} className="prev-row">
                    <span style={{color:"#aaa"}}>{toTitleCase(co.name)}{co.grade&&<span style={{fontSize:10,color:"#a78bfa",marginLeft:6}}>{co.grade}</span>}</span>
                    <span style={{display:"flex",gap:8,alignItems:"center"}}>
                      <span style={{color:"#e8e4d9",fontWeight:700}}>{fmt(alloc)}</span>
                      <span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>
                    </span>
                  </div>;
                })}
              </div>
            );
          })()}

          {/* Validation messages + submit + photo */}
          {(()=>{
            const missCardsOut = txCardsOut.length === 0;
            const missCardsIn  = txType==="trade" && txCardsIn.length === 0;
            const canRecord    = !missCardsOut && !missCardsIn;
            return (
              <div style={{paddingTop:8}}>
                {(missCardsOut || missCardsIn) && (
                  <div style={{marginBottom:10,padding:"8px 12px",background:"#1a0a0a",border:"1px solid #7f1d1d44",borderRadius:3,fontSize:11,color:"#f87171"}}>
                    {missCardsOut && <div>⚠ Select at least one card going out.</div>}
                    {missCardsIn  && <div>⚠ Add at least one card coming in to record a trade.</div>}
                  </div>
                )}
                <div style={{marginBottom:14}}>
                  <ImagePicker value={txImageUrl} onChange={setTxImageUrl} label="Transaction Photo (optional)"/>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                  <button className="btn btn-ghost" onClick={()=>setShowAddTx(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleRecordTransaction}
                    disabled={!canRecord}
                    style={{opacity:canRecord?1:0.4,cursor:canRecord?"pointer":"not-allowed"}}>
                    Record Transaction
                  </button>
                </div>
              </div>
            );
          })()}
        </ModalShell>
      )}

      {/* ═══ EDIT TRANSACTION MODAL ═══ */}
      {editTx&&(
        <ModalShell title="EDIT TRANSACTION" onClose={()=>setEditTx(null)}>
          <div className="grid2" style={{marginBottom:14}}>
            <div><label>Date</label><input className="input" type="date" value={editTx.date} onChange={e=>setEditTx(p=>({...p,date:e.target.value}))}/></div>
            <div><label>Notes</label><input className="input" value={editTx.notes||""} onChange={e=>setEditTx(p=>({...p,notes:e.target.value}))} placeholder="e.g. TCGPlayer"/></div>
          </div>
          <div style={{marginBottom:14}}>
            <ImagePicker value={editTx.imageUrl||""} onChange={v=>setEditTx(p=>({...p,imageUrl:v}))} label="Transaction Photo (optional)"/>
          </div>
          {editTx.cardsOut.length>0&&(
            <div style={{marginBottom:14}}>
              <label style={{color:"#f87171",marginBottom:8}}>Cards Out — {editTx.type==="trade"?"Traded At":"Sold At"} Prices</label>
              {editTx.cardsOut.map((co,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,padding:"8px 12px",background:"#0c0c18",border:"1px solid #1e1e28",borderRadius:3}}>
                  <span style={{flex:1,fontSize:12,color:"#ccc"}}>{co.name}{co.grade&&<span style={{fontSize:10,color:"#a78bfa",marginLeft:6}}>{co.grade}</span>}<span style={{fontSize:10,color:"#555",marginLeft:6}}>mkt {fmt(co.currentMarket||0)}</span></span>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <label style={{margin:0,whiteSpace:"nowrap",fontSize:9}}>{editTx.type==="trade"?"Traded at":"Sold at"} ($)</label>
                    <input className="input" type="number" min="0" step="0.01" style={{width:100,padding:"4px 8px",fontSize:11}}
                      value={co.salePrice??""} onChange={e=>setEditTx(p=>({...p,cardsOut:p.cardsOut.map((c,j)=>j===i?{...c,salePrice:e.target.value}:c)}))}/>
                    {co.salePrice&&toF(co.salePrice)>0&&co.currentMarket>0&&(()=>{const sp=(toF(co.salePrice)/co.currentMarket)*100;return<span className={`pct-pill ${salePillCls(sp)}`}>{pct(sp)}</span>;})()}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="grid2" style={{marginBottom:14}}>
            <div><label style={{color:"#4ade80"}}>Cash Received ($)</label><input className="input" type="number" min="0" step="0.01" value={editTx.cashIn} onChange={e=>setEditTx(p=>({...p,cashIn:e.target.value}))}/></div>
            <div><label style={{color:"#f87171"}}>Cash Paid Out ($)</label><input className="input" type="number" min="0" step="0.01" value={editTx.cashOut} onChange={e=>setEditTx(p=>({...p,cashOut:e.target.value}))}/></div>
          </div>
          {(()=>{
            const ci=toF(editTx.cashIn), co=toF(editTx.cashOut);
            const mktO=editTx.cardsOut.reduce((s,c)=>s+(toF(c.salePrice)||c.currentMarket||0),0);
            const mktI=(editTx.cardsIn||[]).reduce((s,c)=>s+(toF(c.currentMarket)||toF(c.marketAtPurchase)||0),0);
            const nc=ci-co, mp=(mktI+ci)-(mktO+co);
            return <div style={{marginBottom:14,padding:10,background:"#0a0a0f",border:"1px solid #1a1a28",borderRadius:3,display:"flex",gap:20,flexWrap:"wrap",fontSize:12}}>
              <span style={{color:"#555"}}>Net Cash: <span style={{color:nc>=0?"#4ade80":"#f87171",fontWeight:700}}>{nc>=0?"+":"-"}{fmt(nc)}</span></span>
              <span style={{color:"#555"}}>Mkt Profit: <span className={mp>=0?"profit":"loss"} style={{fontWeight:700}}>{mp>=0?"+":"-"}{fmt(mp)}</span></span>
            </div>;
          })()}
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button className="btn btn-ghost" onClick={()=>setEditTx(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveTx}>Save Changes</button>
          </div>
        </ModalShell>
      )}

      {/* ═══ EDIT IN-STOCK CARD MODAL ═══ */}
      {editCard&&(
        <ModalShell title="EDIT CARD" onClose={()=>{ setEditCard(null); setEditCardOwners([]); }}>
          <div style={{marginBottom:14}}><label>Card Name</label><input className="input" value={editCard.name} onChange={e=>setEditCard(p=>({...p,name:e.target.value}))}/></div>
          <div style={{marginBottom:14,padding:14,background:"#0c0c18",borderRadius:4,border:"1px solid #1a1a2e"}}><GradeFields data={editCard} onChange={setEditCard}/></div>
          <div style={{marginBottom:14}}><PricingFields data={{...editCard,currentMarketTouched:true}} onChange={d=>setEditCard(p=>({...p,...d}))}/></div>
          <OwnershipSplit profiles={profiles} owners={editCardOwners} onChange={setEditCardOwners}/>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
            <button className="btn btn-ghost" onClick={()=>{ setEditCard(null); setEditCardOwners([]); }}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveCard}>Save Changes</button>
          </div>
        </ModalShell>
      )}

      {/* ═══ EDIT SOLD CARD MODAL ═══ */}
      {editSold&&(
        <ModalShell title="EDIT SOLD CARD" onClose={()=>setEditSold(null)}>
          <div style={{marginBottom:14}}><label>Card Name</label><input className="input" value={editSold.name} onChange={e=>setEditSold(p=>({...p,name:e.target.value}))}/></div>
          <div style={{marginBottom:14,padding:14,background:"#0c0c18",borderRadius:4,border:"1px solid #1a1a2e"}}><GradeFields data={editSold} onChange={setEditSold}/></div>
          <div className="grid3" style={{marginBottom:14}}>
            <div><label>Buy Price ($)</label><input className="input" type="number" min="0" step="0.01" value={editSold.buyPrice} onChange={e=>setEditSold(p=>({...p,buyPrice:e.target.value}))}/></div>
            <div><label>Mkt @ Purchase ($)</label><input className="input" type="number" min="0" step="0.01" value={editSold.marketAtPurchase} onChange={e=>setEditSold(p=>({...p,marketAtPurchase:e.target.value}))}/></div>
            <div><label>Mkt @ Sale ($)</label><input className="input" type="number" min="0" step="0.01" value={editSold.currentMarket} onChange={e=>setEditSold(p=>({...p,currentMarket:e.target.value}))}/></div>
          </div>
          <div style={{marginBottom:14}}><label>Sale Price ($)</label><input className="input" type="number" min="0" step="0.01" value={editSold.salePrice} onChange={e=>setEditSold(p=>({...p,salePrice:e.target.value}))}/></div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button className="btn btn-ghost" onClick={()=>setEditSold(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveSold}>Save Changes</button>
          </div>
        </ModalShell>
      )}

      {/* ═══ TX DETAIL MODAL ═══ */}
      {detailTx && (
        <TxDetailModal
          tx={detailTx}
          inventory={inventory}
          onClose={()=>setDetailTx(null)}
          onEdit={openEditTx}
          onUndo={handleUndoTransaction}
          fmt={fmt} pct={pct} pillCls={pillCls} salePillCls={salePillCls}
          toTitleCase={toTitleCase}
          partnerFilters={partnerFilters}
          activeProfiles={activeProfiles}
          setDetailCard={setDetailCard}
        />
      )}

      {/* ═══ CARD DETAIL MODAL ═══ */}
      {liveDetailCard && (
        <CardDetailModal
          card={liveDetailCard}
          transactions={transactions}
          inventory={inventory}
          onClose={() => setDetailCard(null)}
          reload={reload}
          fmt={fmt} pct={pct} pillCls={pillCls} salePillCls={salePillCls}
          toTitleCase={toTitleCase} GradeTag={GradeTag}
        />
      )}

      {/* ═══ PROFILES / PARTNERS MODAL ═══ */}
      {showProfiles && (
        <ModalShell title="PARTNERS & EQUITY" onClose={() => { setShowProfiles(false); setEditingProfile(null); setProfileDraft({name:"",color:"#f5a623",initials:""}); }} wide>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>

            {/* LEFT: partner list + default equity */}
            <div>
              {/* Active partners */}
              <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:10}}>
                Active Partners
              </div>
              {profiles.filter(p=>!p.archived).length === 0 && (
                <div style={{color:"#444",fontSize:12,marginBottom:12}}>
                  Add partners to track ownership splits and profit sharing.
                </div>
              )}
              {profiles.filter(p=>!p.archived).map(p => (
                <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 10px",
                  background:"#0e0e18",border:`1px solid ${p.color}33`,borderRadius:4,marginBottom:6}}>
                  <div style={{width:30,height:30,borderRadius:"50%",background:p.color+"22",border:`2px solid ${p.color}`,
                    display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:p.color,flexShrink:0}}>
                    {p.initials || p.name.slice(0,2).toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,color:"#e8e4d9",fontSize:12}}>{p.name}</div>
                    <div style={{fontSize:9,color:"#555"}}>
                      {inventory.filter(c=>c.owners?.some(o=>o.profileId===p.id)).length} cards · eq {fmt(
                        inventory.filter(c=>c.status==="in_stock"&&c.owners?.some(o=>o.profileId===p.id))
                          .reduce((s,c)=>s+(c.currentMarket||0)*(c.owners.find(o=>o.profileId===p.id)?.percentage||0)/100,0)
                      )}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => {
                    setEditingProfile(p);
                    setProfileDraft({name:p.name,color:p.color,initials:p.initials||""});
                  }}>✎</button>
                  <button className="btn btn-ghost btn-sm" title="Archive" style={{color:"#888",fontSize:10}}
                    onClick={() => handleArchiveProfile(p.id, true)}>📦</button>
                  <button className="btn btn-danger btn-sm" title="Delete" onClick={() => handleDeleteProfile(p.id)}>✕</button>
                </div>
              ))}

              {/* Default equity split */}
              {profiles.filter(p=>!p.archived).length >= 2 && (
                <div style={{marginTop:16,padding:12,background:"#0a0a14",border:"1px solid #1e1e30",borderRadius:4}}>
                  <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:8}}>
                    Default Equity Split
                    <span style={{color:"#444",marginLeft:6,textTransform:"none",letterSpacing:0,fontSize:9}}>applied when buying cards</span>
                  </div>
                  <OwnershipSplit
                    profiles={profiles.filter(p=>!p.archived)}
                    owners={equityDefaults.length ? equityDefaults : defaultOwners(profiles.filter(p=>!p.archived))}
                    onChange={handleSaveEquityDefaults}/>
                  <div style={{display:"flex",gap:6,marginTop:8}}>
                    <button className="btn btn-ghost btn-sm" style={{flex:1,fontSize:10}}
                      onClick={() => handleSaveEquityDefaults(defaultOwners(profiles.filter(p=>!p.archived)))}>
                      Reset to Even
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{flex:1,fontSize:10}}
                      onClick={() => handleSaveEquityDefaults([])}>
                      Clear Default
                    </button>
                  </div>
                </div>
              )}

              {/* Archived partners */}
              {profiles.filter(p=>p.archived).length > 0 && (
                <div style={{marginTop:16}}>
                  <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:8}}>
                    Archived Partners
                    <span style={{color:"#333",marginLeft:6,fontSize:9,textTransform:"none",letterSpacing:0}}>history preserved, excluded from splits</span>
                  </div>
                  {profiles.filter(p=>p.archived).map(p => (
                    <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",
                      background:"#0a0a0f",border:"1px solid #1a1a22",borderRadius:4,marginBottom:5,opacity:0.65}}>
                      <div style={{width:24,height:24,borderRadius:"50%",background:"#1a1a22",
                        display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#555",flexShrink:0}}>
                        {p.initials || p.name.slice(0,2).toUpperCase()}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{color:"#555",fontSize:11}}>{p.name}</div>
                        <div style={{fontSize:9,color:"#333"}}>
                          {inventory.filter(c=>c.owners?.some(o=>o.profileId===p.id)).length} cards (archived)
                        </div>
                      </div>
                      <button className="btn btn-ghost btn-sm" style={{fontSize:10,color:"#555"}}
                        title="Restore" onClick={() => handleArchiveProfile(p.id, false)}>↩ Restore</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDeleteProfile(p.id)}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* RIGHT: add/edit form */}
            <div>
              <div style={{fontSize:9,letterSpacing:2,color:"#555",textTransform:"uppercase",marginBottom:12}}>
                {editingProfile ? `Editing: ${editingProfile.name}` : "Add New Partner"}
              </div>
              <div style={{marginBottom:12}}>
                <label style={{marginBottom:4}}>Name</label>
                <input className="input" placeholder="e.g. Alex" value={profileDraft.name}
                  onChange={e=>setProfileDraft(p=>({...p,name:e.target.value}))}/>
              </div>
              <div style={{marginBottom:12}}>
                <label style={{marginBottom:4}}>Initials <span style={{color:"#444",fontSize:10}}>(auto from name)</span></label>
                <input className="input" maxLength={3} placeholder="e.g. AJ" value={profileDraft.initials}
                  onChange={e=>setProfileDraft(p=>({...p,initials:e.target.value.toUpperCase()}))}/>
              </div>
              <div style={{marginBottom:16}}>
                <label style={{marginBottom:6}}>Color</label>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {PROFILE_COLORS.map(c => (
                    <div key={c} onClick={() => setProfileDraft(p=>({...p,color:c}))}
                      style={{width:26,height:26,borderRadius:"50%",background:c,cursor:"pointer",
                        border:profileDraft.color===c?"3px solid #fff":"3px solid transparent",
                        boxShadow:profileDraft.color===c?`0 0 0 1px ${c}`:"none",transition:"all 0.15s"}}/>
                  ))}
                </div>
              </div>
              <div style={{display:"flex",gap:8}}>
                {editingProfile && (
                  <button className="btn btn-ghost" onClick={() => { setEditingProfile(null); setProfileDraft({name:"",color:"#f5a623",initials:""}); }}>
                    Cancel
                  </button>
                )}
                <button className="btn btn-primary" style={{flex:1}} onClick={handleSaveProfile}
                  disabled={!profileDraft.name.trim()}>
                  {editingProfile ? "Save Changes" : "Add Partner"}
                </button>
              </div>

              {/* Preview */}
              {profileDraft.name.trim() && (
                <div style={{marginTop:16,padding:12,background:"#0e0e18",border:"1px solid #1e1e28",borderRadius:4}}>
                  <div style={{fontSize:9,color:"#555",letterSpacing:2,marginBottom:8,textTransform:"uppercase"}}>Preview</div>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:36,height:36,borderRadius:"50%",background:profileDraft.color+"22",
                      border:`2px solid ${profileDraft.color}`,display:"flex",alignItems:"center",
                      justifyContent:"center",fontSize:13,fontWeight:700,color:profileDraft.color}}>
                      {(profileDraft.initials||profileDraft.name.slice(0,2)).toUpperCase()}
                    </div>
                    <div>
                      <div style={{color:"#e8e4d9",fontWeight:700}}>{profileDraft.name}</div>
                      <div style={{display:"flex",gap:3,marginTop:3}}>
                        <span style={{fontSize:9,padding:"1px 5px",borderRadius:2,
                          background:profileDraft.color+"22",color:profileDraft.color,
                          border:`1px solid ${profileDraft.color}44`,fontFamily:"'Space Mono',monospace"}}>
                          {(profileDraft.initials||profileDraft.name.slice(0,2)).toUpperCase()} 50%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
