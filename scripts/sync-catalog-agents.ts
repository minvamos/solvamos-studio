import { loadAgents } from '../server/agents-store.ts';
import { prisma } from '../server/db.ts';

await loadAgents();
const agents = await prisma.agent.count();
const catalogAgents = await prisma.catalogAgent.count();
const sample = await prisma.catalogAgent.findMany({
  select: { agentId: true, title: true, status: true, ownerUserId: true },
  take: 10,
});
console.log(JSON.stringify({ agents, catalogAgents, sample }, null, 2));
await prisma.$disconnect();
