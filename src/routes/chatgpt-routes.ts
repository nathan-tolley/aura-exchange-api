import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guard } from "../auth.js";
import { beginChatGPTConnect, chatGPTConnectionStatus, completeChatGPTConnect, disconnectChatGPTPlan } from "../services/chatgpt-plan-service.js";

export async function registerChatGPTRoutes(app:FastifyInstance):Promise<void> {
  app.get("/api/admin/chatgpt/status",{preHandler:guard({roles:["OWNER","MODERATOR"]})},()=>chatGPTConnectionStatus());
  app.post("/api/admin/chatgpt/connect",{preHandler:guard({roles:["OWNER","MODERATOR"],csrf:true})},async(request)=>({authorizeUrl:await beginChatGPTConnect(request.auth!.id)}));
  app.post("/api/admin/chatgpt/disconnect",{preHandler:guard({roles:["OWNER","MODERATOR"],csrf:true})},async()=>{await disconnectChatGPTPlan();return {ok:true};});
  app.get("/auth/callback",async(request,reply)=>{
    const input=z.object({state:z.string().min(20),code:z.string().min(10),client_id:z.string().min(8)}).parse(request.query);
    await completeChatGPTConnect({state:input.state,code:input.code,clientId:input.client_id});
    return reply.redirect("http://localhost/?chatgpt=connected");
  });
}
