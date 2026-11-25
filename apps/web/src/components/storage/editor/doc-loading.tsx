import { Skeleton, SkeletonBox } from "skullet/react";

/**
 * A doc's page while it gets ready, drawn once for every step of that (its text, the editor,
 * the live doc) so it waits its moment to show only once: a title, then sections of a heading
 * and paragraphs, running past the bottom of the screen like a doc.
 */
export function DocLoading() {
  return (
    <div className="absolute inset-0 z-10 flex overflow-hidden bg-background">
      <Skeleton
        loading
        label="Loading doc"
        className="min-w-0 flex-1"
        skeleton={
          <div className="mx-auto flex w-full max-w-3xl flex-col px-10 py-10">
            <SkeletonBox width="45%" height={28} />
            {DOC_SHAPE.map((section, i) => (
              <div key={i} className="mt-8 flex flex-col gap-6">
                {section.heading && <SkeletonBox width={`${section.heading}%`} height={20} />}
                {section.paragraphs.map((lines, j) => (
                  <div key={j} className="flex flex-col gap-3">
                    {lines.map((width, k) => (
                      <SkeletonBox key={k} width={`${width}%`} height={12} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        }
      >
        {null}
      </Skeleton>
    </div>
  );
}

const DOC_SHAPE: { heading?: number; paragraphs: number[][] }[] = [
  { paragraphs: [[96, 92, 98, 64]] },
  {
    heading: 32,
    paragraphs: [
      [94, 97, 90, 72],
      [98, 88, 45],
    ],
  },
  {
    heading: 26,
    paragraphs: [
      [92, 96, 99, 94, 58],
      [90, 70],
    ],
  },
  {
    heading: 36,
    paragraphs: [
      [97, 93, 86],
      [95, 98, 91, 66],
    ],
  },
  {
    heading: 28,
    paragraphs: [
      [94, 99, 90, 52],
      [96, 84],
    ],
  },
];
