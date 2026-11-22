/**
 * 水力候选生成器：按水力传播范围与事件窗口召回候选。
 *
 * 排放窗口 = [事件起点 − 传播时间上限, 事件终点 − 传播时间下限]。
 * 泵站中途切换时按“排放时刻所处体制”分别倒推并裁剪：
 * 切换前排放的水走切换前体制，切换后排放的水走切换后体制；
 * 某一体制下无可行排放时刻时该体制窗口为空（如实标注，不静默丢弃）。
 * 召回从宽、不凭时间接近排除：候选窗口只由水力传播范围与事件窗口决定。
 */

import type { CandidateRecall, InvestigationRegistry, OutfallEvent, PumpSwitch, SourceRegistration } from './types';

export interface RecallResult {
  source: SourceRegistration;
  recall: CandidateRecall;
}

function switchesAffecting(registry: InvestigationRegistry, sewerId: string, from: number, to: number): PumpSwitch[] {
  return registry.pumpSwitches
    .filter((sw) => !sw.revoked && sw.at >= from && sw.at <= to && sw.affects.some((a) => a.sewerId === sewerId))
    .sort((a, b) => a.at - b.at);
}

export function recallCandidates(registry: InvestigationRegistry, event: OutfallEvent): RecallResult[] {
  const results: RecallResult[] = [];
  for (const source of registry.sources) {
    if (source.revoked) continue;
    // 体制序列：常规体制 + 每次切换后的新体制；体制有效期按切换时刻切开
    const switches = switchesAffecting(registry, source.access.sewerId, event.windowFrom - 6 * 3_600_000, event.windowTo);
    const regimes: CandidateRecall['regimes'] = [];
    const notes: string[] = [];

    const clip = (from: number, to: number, validFrom: number | null, validTo: number | null): { from: number; to: number } | null => {
      const f = validFrom === null ? from : Math.max(from, validFrom);
      const t = validTo === null ? to : Math.min(to, validTo);
      return f < t ? { from: f, to: t } : null;
    };

    const firstSwitchAt = switches.length > 0 ? switches[0].at : null;
    const baseRaw = {
      from: event.windowFrom - source.access.travelTimeS[1] * 1000,
      to: event.windowTo - source.access.travelTimeS[0] * 1000,
    };
    const baseWindow = clip(baseRaw.from, baseRaw.to, null, firstSwitchAt);
    regimes.push({
      label: switches.length > 0 ? '常规体制（切换前排放）' : '常规体制',
      travelTimeS: source.access.travelTimeS,
      dischargeWindow: baseWindow,
    });
    if (switches.length > 0 && baseWindow === null) {
      notes.push('按切换前体制倒推的排放窗口完全落在切换时刻之后，该体制下无可行排放时刻（已裁剪）。');
    }

    switches.forEach((sw, i) => {
      const affect = sw.affects.find((a) => a.sewerId === source.access.sewerId);
      if (!affect) return;
      const validFrom = sw.at;
      const validTo = i + 1 < switches.length ? switches[i + 1].at : null;
      const raw = {
        from: event.windowFrom - affect.travelTimeAfterS[1] * 1000,
        to: event.windowTo - affect.travelTimeAfterS[0] * 1000,
      };
      regimes.push({
        label: `${sw.stationName}「${sw.toMode}」体制（${timeText(sw.at)} 切换后排放）`,
        travelTimeS: affect.travelTimeAfterS,
        dischargeWindow: clip(raw.from, raw.to, validFrom, validTo),
      });
      notes.push(
        `泵站 ${sw.stationName} 于 ${timeText(sw.at)} 由「${sw.fromMode}」切换为「${sw.toMode}」：切换后排放的传播时间变为 ${affect.travelTimeAfterS[0]}–${affect.travelTimeAfterS[1]} s，已按体制分别倒推。`,
      );
    });

    const nonEmpty = regimes.map((r) => r.dischargeWindow).filter((w): w is { from: number; to: number } => w !== null);
    const hull =
      nonEmpty.length > 0
        ? { from: Math.min(...nonEmpty.map((w) => w.from)), to: Math.max(...nonEmpty.map((w) => w.to)) }
        : { from: event.windowFrom, to: event.windowFrom };
    if (nonEmpty.length === 0) notes.push('所有体制下均无可行排放窗口：该来源在事件窗口内无水力通路（仍保留候选记录备查）。');

    results.push({
      source,
      recall: {
        regimes,
        dischargeWindow: hull,
        pumpSwitchMidEvent: switches.length > 0,
        notes,
      },
    });
  }
  return results;
}

/** 排放窗口重叠检查：任一非空体制窗口与 [from,to) 相交即视为重叠 */
export function recallOverlaps(recall: CandidateRecall, from: number | null, to: number | null): boolean {
  if (from === null || to === null) return false;
  return recall.regimes.some((r) => r.dischargeWindow !== null && r.dischargeWindow.from < to && r.dischargeWindow.to > from);
}

function timeText(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(11, 19);
}
