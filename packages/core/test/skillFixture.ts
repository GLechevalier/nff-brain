// Shared BRAIN-NODE.json fixture. NOT a *.test.ts file on purpose — importing
// a suite to borrow its fixture would re-run that suite in every consumer.
//
// This is CANONICAL: exactly the key order and spacing serializeSkillFile
// emits, so `parse → serialize` must reproduce it byte for byte. Every
// round-trip assertion in the suite anchors on that.

export const CANONICAL = `{
  "format": "brain-node",
  "version": 1,
  "tree": "li-read-card",
  "title": "Read role and company off a LinkedIn result card",
  "content": "The card usually carries both in its subtitle, but LinkedIn renders that line lazily and about one card in five arrives blank.",
  "when": "the plan is on an evaluateCards step and readResultCards returned cards",
  "verify": "every card has a role and company, or is explicitly marked unreadable",
  "tags": [
    "linkedin",
    "people-search",
    "card"
  ],
  "steps": [
    {
      "key": "read-subtitle",
      "title": "Read the subtitle line as it stands",
      "content": "Take the subtitle verbatim and split on the first ' at '. Left is the role, right is the company.",
      "when": "the card has any subtitle text at all",
      "verify": "role and company are both non-empty after the split"
    },
    {
      "key": "subtitle-missing",
      "title": "The subtitle is blank or unsplittable",
      "content": "Two routes solve this. They are alternatives, not a sequence.",
      "when": "read-subtitle produced an empty role or company",
      "steps": [
        {
          "key": "scroll-retry",
          "title": "Scroll the card into view and re-read",
          "kind": "alt",
          "content": "Scroll the card to the centre of the viewport, wait 400ms, then re-read. This resolves the lazy-render case.",
          "when": "the card is still in the result list",
          "verify": "the subtitle now splits into role and company",
          "onFail": [
            "open-profile"
          ]
        },
        {
          "key": "open-profile",
          "title": "Open the profile and read the headline",
          "kind": "alt",
          "content": "Open the profile href in a background tab, read the headline, close the tab. Visible to LinkedIn as a profile view.",
          "when": "scroll-retry already failed for this card",
          "verify": "the headline yielded a role and company"
        }
      ]
    }
  ]
}
`;
