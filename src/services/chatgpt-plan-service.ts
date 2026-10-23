import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { maybeOne, pool, withTransaction } from "../db.js";

const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

interface Credentials { access_token:string;refresh_token:string;id_token:string;token_type:string;expires_in:number;scope?:string }
interface ConnectionRow { id:string;owner_user_id:string;email:string;subject:string;client_id:string;scopes:string[];encrypted_credentials:string;selected_model:string|null;expires_at:Date }
interface Discovery { issuer:string;jwks_uri:string;revocation_endpoint?:string }

const encryptionKey = createHash("sha256").update(`aura-chatgpt:${config.SESSION_SECRET}`).digest();
function encrypt(value:Credentials) { const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",encryptionKey,iv),body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString("base64url"); }
function decrypt(value:string):Credentials { const packed=Buffer.from(value,"base64url"),iv=packed.subarray(0,12),tag=packed.subarray(12,28),body=packed.subarray(28),decipher=createDecipheriv("aes-256-gcm",encryptionKey,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString("utf8")) as Credentials; }
const base64url = (value:Buffer) => value.toString("base64url");
const challenge = (verifier:string) => base64url(createHash("sha256").update(verifier).digest());

async function hostId(client:PoolClient):Promise<string> {
  const result=await client.query<{value:{id?:string}}>("SELECT value FROM system_state WHERE key='chatgpt_host_id' FOR UPDATE");
  const current=result.rows[0]?.value.id;if(current)return current;
  const id=`urn:uuid:${randomUUID()}`;
  await client.query("INSERT INTO system_state(key,value) VALUES ('chatgpt_host_id',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify({id})]);
  return id;
}

export async function beginChatGPTConnect(ownerUserId:string):Promise<string> {
  return withTransaction(async(client)=>{
    await client.query("DELETE FROM chatgpt_oauth_attempts WHERE expires_at<now() OR owner_user_id=$1",[ownerUserId]);
    const state=base64url(randomBytes(32)),nonce=base64url(randomBytes(32)),verifier=base64url(randomBytes(48)),host=await hostId(client);
    await client.query("INSERT INTO chatgpt_oauth_attempts(state,owner_user_id,code_verifier,nonce,redirect_uri) VALUES ($1,$2,$3,$4,$5)",[state,ownerUserId,verifier,nonce,config.CHATGPT_CALLBACK_URL]);
    const url=new URL(AUTHORIZE_URL);
    for(const [key,value] of Object.entries({client_id:"dynamic_agent_client",agent_name_hint:"Aura Exchange",ext_agent_host_id:host,response_type:"code",redirect_uri:config.CHATGPT_CALLBACK_URL,scope:SCOPES,resource:RESOURCE,state,nonce,code_challenge_method:"S256",code_challenge:challenge(verifier)}))url.searchParams.set(key,value);
    return url.toString();
  });
}

export async function completeChatGPTConnect(query:{state:string;code:string;clientId:string}):Promise<void> {
  const attempt=await withTransaction(async(client)=>{
    const row=await maybeOne<{state:string;owner_user_id:string;code_verifier:string;nonce:string;redirect_uri:string}>(client,"DELETE FROM chatgpt_oauth_attempts WHERE state=$1 AND expires_at>now() RETURNING *",[query.state]);
    if(!row)throw new Error("This ChatGPT sign-in attempt expired or was already used.");return row;
  });
  if(!query.clientId.startsWith("oaiapp_"))throw new Error("OpenAI did not return a valid issued client ID.");
  const body=new URLSearchParams({grant_type:"authorization_code",client_id:query.clientId,code:query.code,code_verifier:attempt.code_verifier,redirect_uri:attempt.redirect_uri,resource:RESOURCE});
  const tokenResponse=await fetch(TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  if(!tokenResponse.ok)throw new Error(`ChatGPT token exchange failed (${tokenResponse.status}).`);
  const credentials=await tokenResponse.json() as Credentials;
  const discoveryResponse=await fetch(DISCOVERY_URL);if(!discoveryResponse.ok)throw new Error("Could not load OpenAI identity configuration.");
  const discovery=await discoveryResponse.json() as Discovery;
  const verified=await jwtVerify(credentials.id_token,createRemoteJWKSet(new URL(discovery.jwks_uri)),{issuer:discovery.issuer,audience:query.clientId});
  if(verified.payload.nonce!==attempt.nonce)throw new Error("ChatGPT sign-in nonce did not match.");
  if(!verified.payload.sub||typeof verified.payload.email!=="string")throw new Error("ChatGPT identity was incomplete.");
  const scopes=(credentials.scope??SCOPES).split(" ");
  if(!scopes.includes("chatgpt.tokens.use.direct"))throw new Error("ChatGPT plan usage was not authorized.");
  await pool.query(
    `INSERT INTO chatgpt_connections(owner_user_id,email,subject,client_id,scopes,encrypted_credentials,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,now()+($7::text||' seconds')::interval)
     ON CONFLICT(owner_user_id) DO UPDATE SET email=EXCLUDED.email,subject=EXCLUDED.subject,client_id=EXCLUDED.client_id,
       scopes=EXCLUDED.scopes,encrypted_credentials=EXCLUDED.encrypted_credentials,expires_at=EXCLUDED.expires_at,updated_at=now()`,
    [attempt.owner_user_id,verified.payload.email,verified.payload.sub,query.clientId,JSON.stringify(scopes),encrypt(credentials),credentials.expires_in]
  );
}

async function activeConnection():Promise<ConnectionRow|null> { return maybeOne<ConnectionRow>(pool,"SELECT * FROM chatgpt_connections ORDER BY updated_at DESC LIMIT 1"); }
async function refreshConnection(row:ConnectionRow):Promise<ConnectionRow> {
  const old=decrypt(row.encrypted_credentials),body=new URLSearchParams({grant_type:"refresh_token",client_id:row.client_id,refresh_token:old.refresh_token,resource:RESOURCE});
  const response=await fetch(TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  if(!response.ok)throw new Error(`ChatGPT plan authorization needs to be reconnected (${response.status}).`);
  const next=await response.json() as Partial<Credentials>;
  const credentials:Credentials={...old,...next,refresh_token:next.refresh_token??old.refresh_token,id_token:next.id_token??old.id_token} as Credentials;
  const result=await pool.query<ConnectionRow>("UPDATE chatgpt_connections SET encrypted_credentials=$1,expires_at=now()+($2::text||' seconds')::interval,scopes=$3,updated_at=now() WHERE id=$4 RETURNING *",[encrypt(credentials),credentials.expires_in,JSON.stringify((credentials.scope??row.scopes.join(" ")).split(" ")),row.id]);
  return result.rows[0]!;
}

export async function getChatGPTPlanAccess():Promise<{accessToken:string;model:string;email:string}|null> {
  let row=await activeConnection();if(!row)return null;
  if(row.expires_at.getTime()<Date.now()+60_000)row=await refreshConnection(row);
  const credentials=decrypt(row.encrypted_credentials);
  let model=row.selected_model;
  if(!model){const response=await fetch(`${RESOURCE}/models`,{headers:{authorization:`Bearer ${credentials.access_token}`}});if(!response.ok)throw new Error("Could not list models available to the connected ChatGPT account.");const data=await response.json() as {models?:Array<{slug:string;visibility?:string}>};model=data.models?.find((item)=>item.visibility==="list")?.slug??data.models?.[0]?.slug??null;if(!model)throw new Error("No ChatGPT-plan models are available.");await pool.query("UPDATE chatgpt_connections SET selected_model=$1,updated_at=now() WHERE id=$2",[model,row.id]);}
  return {accessToken:credentials.access_token,model,email:row.email};
}

export async function chatGPTConnectionStatus() { const row=await activeConnection();return row?{connected:true,email:row.email,model:row.selected_model,expiresAt:row.expires_at.toISOString()}:{connected:false}; }
export async function disconnectChatGPTPlan():Promise<void> { const row=await activeConnection();if(!row)return;const credentials=decrypt(row.encrypted_credentials);try{const discovery=await (await fetch(DISCOVERY_URL)).json() as Discovery;if(discovery.revocation_endpoint)await fetch(discovery.revocation_endpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:credentials.refresh_token,token_type_hint:"refresh_token",client_id:row.client_id})});}finally{await pool.query("DELETE FROM chatgpt_connections WHERE id=$1",[row.id]);} }
