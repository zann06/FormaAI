import { SYSTEM_PROMPT } from '../generation/prompts.js';

export interface MappingPromptSection {
  sectionId: string;
  heading: string;
  level: number;
  requirements: string[];
  evidence: Array<{ id: string; text: string }>;
}

export function buildMappingMessages(input: {
  projectTitle: string;
  language: string;
  sections: MappingPromptSection[];
}) {
  const sectionBlocks = input.sections
    .map((section) => {
      const evidence = section.evidence
        .map((item) => `<source_document id="${item.id}">\n${item.text}\n</source_document>`)
        .join('\n');
      return `### SECTION
sectionId: ${section.sectionId}
heading: ${section.heading}
level: ${section.level}
baseline requirements: ${section.requirements.join('; ') || 'none'}
retrieved evidence:
${evidence || '(none retrieved)'}`;
    })
    .join('\n\n');

  const user = `You are preparing a content plan for each section of a report template. The report is "${input.projectTitle}" written in "${input.language}".

For each section return:
- purpose: one sentence describing what the section must accomplish in this report.
- requirements: concrete requirements (what facts/figures/dates must appear), derived from the heading and the template context. Do not invent facts.
- evidenceChunkIds: the IDs of the <source_document> blocks that are genuinely relevant to this section. Only use IDs that appear above. It is correct to return an empty array when nothing is relevant.
- gaps: specific information that the section needs but the evidence does not provide (e.g. "no budget figures in any document"). Be precise; this drives the user's missing-information checklist.
- contentPlan: 2-5 ordered points describing what to write, without writing the prose.

Do not force unrelated evidence into a section. Return JSON only matching the schema: {"sections":[...]}.

${sectionBlocks}`;

  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: user },
  ];
}
