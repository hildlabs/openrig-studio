// Pipeline findings are structured ({ code, ...params }) so the UI can show them in the
// user's language while the model always gets English.
const r2 = v => Math.round(v * 100) / 100;

const TEXT = {
  en: {
    unknownJoint: p => `Unknown joint "${p.part}" ignored.`,
    unknownTarget: p => `IK target "${p.part}" is unknown (hands and feet only).`,
    invalidTarget: p => `IK target ${p.part} at t=${p.t} has no valid position.`,
    offsetTooLarge: p => `${p.part} offset at t=${p.t} is too large (only LowerTorso may move far); clamped.`,
    noLength: () => 'The animation had no length; added 1 s.',
    clamped: p => `${p.part} rot.${p.axis}=${r2(p.value)}° at t=${p.t} is outside ${p.lo}..${p.hi}°; clamped.`,
    unreachable: p => `t=${p.t}: ${p.part} target [${p.target.join(', ')}] is out of reach (${r2(p.error)} studs off).`,
    footInGround: p => `t=${p.t}: a foot is ${r2(p.depth)} studs inside the ground.`,
    limbInBody: p => `t=${p.t}: ${p.part} is inside the ${p.body} (move the arm further out or forward).`,
    pop: p => `t=${p.t}: ${p.part} snaps (${p.speed}°/s); give it more time, an in-between pose or 'Out' easing.`,
    loopMismatch: p => `Loop: ${p.part} ends differently than it starts (visible jump when repeating).`,
    bodyLowered: p => `t=${p.t}: body height adjusted by ${r2(p.delta)} so the feet touch the ground.`,
    flowSmoothed: p => `Easing switched to continuous motion on ${p.count} pass-through key${p.count === 1 ? '' : 's'}.`,
    liftedBetween: p => `Body lifted at ${p.count} point${p.count === 1 ? '' : 's'} between keyframes so the feet don't go through the ground.`,
    importEasing: p => `${p.part} at t=${p.t}: easing ${p.style} imported as InOut.`,
    importConstantIn: p => `${p.part} at t=${p.t}: Constant/In jumps to the next pose in Roblox; imported as a hold.`,
  },
  de: {
    unknownJoint: p => `Unbekanntes Gelenk „${p.part}“ ignoriert.`,
    unknownTarget: p => `IK-Ziel „${p.part}“ ist unbekannt (nur Hände und Füße).`,
    invalidTarget: p => `IK-Ziel ${p.part} bei t=${p.t} hat keine gültige Position.`,
    offsetTooLarge: p => `Verschiebung von ${p.part} bei t=${p.t} ist zu groß (nur LowerTorso darf weit wandern); begrenzt.`,
    noLength: () => 'Die Animation hatte keine Länge; 1 s ergänzt.',
    clamped: p => `${p.part} rot.${p.axis}=${r2(p.value)}° bei t=${p.t} liegt außerhalb ${p.lo}..${p.hi}°; begrenzt.`,
    unreachable: p => `t=${p.t}: Ziel für ${p.part} [${p.target.join(', ')}] ist nicht erreichbar (${r2(p.error)} studs daneben).`,
    footInGround: p => `t=${p.t}: Ein Fuß steckt ${r2(p.depth)} studs im Boden.`,
    limbInBody: p => `t=${p.t}: ${p.part} steckt im ${p.body} (Arm weiter nach außen oder vorn führen).`,
    pop: p => `t=${p.t}: ${p.part} dreht ruckartig (${p.speed}°/s); mehr Zeit, Zwischenpose oder 'Out'-Easing.`,
    loopMismatch: p => `Loop: ${p.part} endet anders als es beginnt (sichtbarer Sprung beim Wiederholen).`,
    bodyLowered: p => `t=${p.t}: Körperhöhe um ${r2(p.delta)} angepasst, damit die Füße den Boden berühren.`,
    flowSmoothed: p => `Easing an ${p.count} Durchgangs-Key${p.count === 1 ? '' : 's'} auf fließende Bewegung umgestellt.`,
    liftedBetween: p => `Körper an ${p.count} Stelle${p.count === 1 ? '' : 'n'} zwischen Keyframes angehoben, damit die Füße nicht durch den Boden gehen.`,
    importEasing: p => `${p.part} bei t=${p.t}: Easing ${p.style} als InOut übernommen.`,
    importConstantIn: p => `${p.part} bei t=${p.t}: Constant/In springt in Roblox sofort zur nächsten Pose; als Halten übernommen.`,
  },
};

export function formatIssue(issue, lang = 'en') {
  const table = TEXT[lang] ?? TEXT.en;
  const fn = table[issue?.code] ?? TEXT.en[issue?.code];
  return fn ? fn(issue) : String(issue?.code ?? issue);
}
export const formatIssues = (list, lang) => (list ?? []).map(i => formatIssue(i, lang));
