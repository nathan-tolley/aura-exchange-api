import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { AdminIcon, ShieldIcon } from "../icons";

interface Person { id: string; display_name: string; ticker: string; is_active: boolean; user_id:string|null; username: string | null; role: string | null; seasonal_aura: number }
interface Review { id: string; display_name: string; ticker: string; explanation: string; verdict: string; delta: number; confidence: string; rationale: string; policy_flags: string[] }

export function AdminView() {
  const [people, setPeople] = useState<Person[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [claim, setClaim] = useState<{ name: string; code: string } | null>(null);
  const [error, setError] = useState("");
  async function load() {
    const [roster, queue] = await Promise.all([
      api<{ people: Person[] }>("/api/admin/roster"), api<{ items: Review[] }>("/api/moderation/review")
    ]);
    setPeople(roster.people); setReviews(queue.items);
  }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  async function addPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api<{ claimCode: string }>("/api/admin/roster", { method: "POST", body: JSON.stringify({ displayName: data.displayName, ticker: data.ticker }) });
      setClaim({ name: String(data.displayName), code: result.claimCode }); form.reset(); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add listing"); }
  }
  async function resolve(id: string, action: "APPROVE"|"REJECT"|"OVERTURN", delta?: number) {
    const note = window.prompt("Moderator note", action === "APPROVE" ? "Approved after review." : "Resolved by moderator.");
    if (!note) return;
    await api(`/api/moderation/review/${id}`, { method: "POST", body: JSON.stringify({ action, delta, note }) });
    await load();
  }
  async function issueReset(person:Person) {
    if (!person.user_id) return;
    const result=await api<{resetCode:string}>(`/api/admin/users/${person.user_id}/reset-code`,{method:"POST",body:"{}"});
    setClaim({name:`${person.display_name} password reset`,code:result.resetCode});
  }
  async function delist(person:Person) {
    if (!window.confirm(`Freeze and delist $${person.ticker}? Open positions will settle at the current mark.`)) return;
    await api(`/api/admin/roster/${person.id}/delist`,{method:"POST",body:"{}"});
    await load();
  }
  return <section className="page-content">
    <header className="page-heading"><div><p className="eyebrow">CONTROL ROOM</p><h1>Exchange operations</h1><p>Listings, claim codes, and rulings that need a human.</p></div></header>
    {error && <div className="form-error">{error}</div>}
    <div className="admin-grid">
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">NEW LISTING</p><h2>Add a person</h2></div><AdminIcon /></div>
        <form className="inline-form" onSubmit={addPerson}><label>Display name<input name="displayName" required maxLength={60}/></label><label>Ticker<input name="ticker" required minLength={3} maxLength={5} placeholder="JANE"/></label><button className="button primary">Create claim code</button></form>
        {claim && <div className="claim-ticket"><span>Give this one-time code to {claim.name}</span><strong>{claim.code}</strong><small>Shown once · expires in 30 days</small></div>}
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">ROSTER</p><h2>{people.length} listings</h2></div></div>
        <div className="roster-list">{people.map((person) => <div key={person.id}><span className="avatar small">{person.display_name.slice(0,2).toUpperCase()}</span><span><b>{person.display_name}</b><small>${person.ticker} · {person.seasonal_aura} aura</small></span>{person.user_id&&<button className="text-button" onClick={()=>issueReset(person)}>Reset</button>}{person.is_active&&<button className="text-button danger-text" onClick={()=>delist(person)}>Delist</button>}<em className={person.is_active?"status active":"status"}>{person.is_active?"Active":"Unclaimed"}</em></div>)}</div>
      </section>
    </div>
    <section className="panel review-panel"><div className="panel-heading"><div><p className="eyebrow">HUMAN JUDGMENT</p><h2>Review queue <span>{reviews.length}</span></h2></div><ShieldIcon /></div>
      {reviews.length===0 && <div className="empty-compact">Nothing needs a grown-up right now.</div>}
      {reviews.map((review) => <div className="review-item" key={review.id}><div><span className="ticker">${review.ticker}</span><h3>{review.explanation}</h3><p>AI: {review.verdict} {review.delta > 0 ? "+" : ""}{review.delta} · {Math.round(Number(review.confidence)*100)}% · “{review.rationale}”</p>{review.policy_flags?.length > 0 && <div className="flag-row">{review.policy_flags.map((flag) => <span key={flag}>{flag.replaceAll("_"," ")}</span>)}</div>}</div><div className="review-actions"><button className="button small" onClick={()=>resolve(review.id,"APPROVE")}>Approve</button><button className="button small danger" onClick={()=>resolve(review.id,"REJECT")}>Reject</button><button className="text-button" onClick={()=>resolve(review.id,"OVERTURN")}>Overturn</button></div></div>)}
    </section>
  </section>;
}

