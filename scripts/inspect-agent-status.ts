import { prisma } from '../server/db.ts';

const rows = await prisma.agent.findMany({ select: { id: true, status: true } });
console.log(JSON.stringify(rows, null, 2));
await prisma.catalogAgent.updateMany({
  where: { agentId: { in: ['support-copilot-001', 'academic-research-001'] } },
  data: { status: 'listed' },
});
const after = await prisma.catalogAgent.findMany({
  where: { agentId: { in: ['support-copilot-001', 'academic-research-001'] } },
  select: { agentId: true, status: true },
});
console.log('fixed', after);
await prisma.$disconnect();
