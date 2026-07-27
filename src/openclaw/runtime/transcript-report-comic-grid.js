import {
  clipDisplay,
  displayCols,
  ellipsizeText,
  escapeXml,
  fontCssRules,
  fontFamily,
  graphemeClusters,
  omitEmoji,
  textRuns,
  textUnits,
  wrapText,
} from './transcript-report-stylekit.js';

const CANVAS_MARGIN = 24;
const FRAME_MARGIN = 16;
export const HEADER_Y = 48;
export const HEADER_CARD_HEIGHT_FULL = 493;
export const HEADER_CARD_HEIGHT_NO_CONTEXT = 168;
export const HEADER_CARD_HEIGHT_COMPACT = 96;
export const HEADER_BOTTOM_PAD = 20;
export const BODY_TOP_GAP = 24;
const PAGE_BOTTOM = 54;
const ITEM_GAP = 22;
const TIME_ROW_HEIGHT = 42;
const ELLIPSIS_HEIGHT = 34;
const BUBBLE_PAD_X = 32;
const BUBBLE_PAD_Y = 22;
const LABEL_HEIGHT = 30;
const LABEL_OVERLAP = 18;
const LABEL_RAISE = 9;
const LABEL_MAX_COLS = 14;
const BUBBLE_MAX_RATIO = 0.64;
const BUBBLE_MIN_WIDTH = 200;
const FONT_SIZE = 18;
const SMALL_FONT_SIZE = 12;
const LABEL_FONT_SIZE = 15;
export const TITLE_FONT_SIZE = 25;
const LINE_HEIGHT = 29;
export const HEADER_TOPIC_MAX_UNITS = 26;
export const HEADER_COMPACT_TOPIC_MAX_UNITS = 26;
export const HEADER_TOPIC_SIDE_PADDING = 36;
export const CONTEXT_CARD_HEIGHT = 76;
export const CONTEXT_CARD_GAP = 28;
export const PROFILE_CARD_HEIGHT = 82;
export const PROFILE_CARD_GAP = 16;
export const PROFILE_CARD_STACK_GAP = 28;
export const PROFILE_TO_CONTEXT_GAP = 28;
export const CONTEXT_CARDS_TOP = 171;
export const CONTEXT_LABEL_FONT_SIZE = 12;
export const CONTEXT_LEGEND_HEIGHT = 26;
export const CONTEXT_TEXT_FONT_SIZE = 14;
export const CONTEXT_TEXT_LINE_HEIGHT = 21;
export const CONTEXT_TEXT_MAX_LINES = 2;
const CONTEXT_TEXT_BASELINE_CENTER_OFFSET = 4;
const TAG_HEIGHT = 58;
const TAG_ICON_SIZE = 30;
const TAG_ICON_GAP = 12;
const TAG_ICON_TOP_GAP = 8;
const TAG_ROW_GAP = 10;
const TAG_FALLBACK_MAX_COLS = 10;
const MAX_VISIBLE_TAGS = 8;
const TEXT_UNIT_PX = 18;
export const IDENTITY_NAME_FONT_SIZE = 22;
export const IDENTITY_CODE_FONT_SIZE = 13;
export const IDENTITY_COMPACT_NAME_FONT_SIZE = 19;
export const IDENTITY_COMPACT_CODE_FONT_SIZE = 12;
export const BLACK = '#090909';

const THEME = Object.freeze({
  paper: '#FBF8EF',
  paperWarm: '#FFFDF7',
  headerFill: '#FEF5D8',
  muted: '#222222',
  leftFill: '#EFFFF5',
  leftLabel: '#62E69D',
  rightFill: '#EFE0FF',
  rightLabel: '#B785FF',
  timeFill: '#FFFDF7',
  directBadge: '#67DDF1',
  worldBadge: '#FFB34F',
  roleBadge: '#FF6A9A',
  chatBadge: '#D3B7FF',
  passportStrip: '#FFFDF7',
});

const TAG_ICON_THEMES = Object.freeze({
  like: ['#D8F4FF', '#58B7FF'],
  dislike: ['#FFE0EA', '#FF6A9A'],
  'request end': ['#FFF0A8', '#FF9F2F'],
});

const fixed = (value, places = 1) => Number(value).toFixed(places);

export function bodyParticipantName(label) {
  const value = String(label || 'AGENT').trim();
  const [name, code] = splitIdentity(value);
  return code ? name : value;
}

export function labelText(label) {
  return clipDisplay(bodyParticipantName(label).toUpperCase(), LABEL_MAX_COLS);
}

function labelWidth(label) {
  return Math.max(86, Math.min(158, displayCols(label) * 11 + 30));
}

function tagName(tag) {
  return String(tag ?? '').trim().toLowerCase();
}

function fallbackTagLabel(tag) {
  return clipDisplay(String(tag || 'tag'), TAG_FALLBACK_MAX_COLS);
}

function tagWidth(tag) {
  const normalized = tagName(tag);
  if (['like', 'dislike', 'request end'].includes(normalized)) return TAG_ICON_SIZE;
  return Math.max(58, Math.min(126, displayCols(fallbackTagLabel(normalized)) * 8 + 24));
}

function visibleTags(tags) {
  if (tags.length <= MAX_VISIBLE_TAGS) return [...tags];
  const kept = tags.slice(0, MAX_VISIBLE_TAGS - 1);
  kept.push(`+${tags.length - kept.length} more`);
  return kept;
}

function packTagRows(tags, maxWidth) {
  const rows = [];
  let row = [];
  let used = 0;
  for (const tag of tags) {
    const width = tagWidth(tag);
    const needed = row.length ? TAG_ICON_GAP + width : width;
    if (row.length && used + needed > maxWidth) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(tag);
    used += row.length > 1 ? TAG_ICON_GAP + width : width;
  }
  if (row.length) rows.push(row);
  return rows;
}

function tagRowWidth(tags) {
  return tags.reduce((sum, tag) => sum + tagWidth(tag), 0)
    + Math.max(0, tags.length - 1) * TAG_ICON_GAP;
}

export function measureTranscriptItem(item, width) {
  const contentWidth = Math.max(270, Math.trunc(width * BUBBLE_MAX_RATIO));
  if (item.kind === 'ellipsis') {
    return {
      kind: 'ellipsis',
      message: null,
      lines: [],
      width: contentWidth,
      height: ELLIPSIS_HEIGHT,
      omittedCount: item.omitted,
      label: item.label,
    };
  }
  if (item.kind === 'time') {
    return {
      kind: 'time',
      message: null,
      lines: [],
      width: contentWidth,
      height: TIME_ROW_HEIGHT,
      label: item.label,
    };
  }

  const { message } = item;
  const maxUnits = Math.max(18, (contentWidth - BUBBLE_PAD_X * 2) / TEXT_UNIT_PX);
  const lines = wrapText(message.text, maxUnits);
  const tagRows = packTagRows(visibleTags(message.tags), contentWidth - BUBBLE_PAD_X * 2);
  const labelUnits = textUnits(labelText(message.participantLabel)) + 4;
  const contentUnits = Math.max(
    ...lines.map((line) => textUnits(line)),
    ...tagRows.map((row) => tagRowWidth(row) / TEXT_UNIT_PX),
    labelUnits,
    10,
  );
  const bubbleWidth = Math.trunc(Math.min(
    contentWidth,
    Math.max(BUBBLE_MIN_WIDTH, contentUnits * TEXT_UNIT_PX + BUBBLE_PAD_X * 2),
  ));
  const textHeight = lines.length * LINE_HEIGHT;
  const tagHeight = tagRows.length
    ? TAG_HEIGHT + Math.max(0, tagRows.length - 1) * (TAG_ICON_SIZE + TAG_ROW_GAP)
    : 0;
  const bubbleHeight = BUBBLE_PAD_Y * 2 + textHeight + tagHeight;
  return {
    kind: 'message',
    message,
    lines,
    width: bubbleWidth,
    height: LABEL_HEIGHT - LABEL_OVERLAP + bubbleHeight + 10,
    tagRows,
    tagHeight,
    textHeight,
  };
}

function headerValue(header, ...names) {
  if (!header || typeof header !== 'object') return '';
  for (const name of names) {
    const value = header[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function normalizeInitiatedBy(value) {
  const normalized = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  if (['peer', 'inbound', 'remote', 'from-peer'].includes(normalized)) return 'peer';
  if (['local', 'me', 'outbound', 'from-local'].includes(normalized)) return 'local';
  return '';
}

export function headerContextBlocks(header, fallbackText = '') {
  const rawBlocks = header?.contextBlocks || header?.context_blocks;
  const blocks = [];
  if (Array.isArray(rawBlocks)) {
    for (const item of rawBlocks) {
      const kind = headerValue(item, 'kind');
      const label = headerValue(item, 'label').replace(/[：: ]+$/u, '');
      const text = headerValue(item, 'text');
      const source = headerValue(item, 'source');
      if (text) blocks.push({ kind: kind || 'profile', label, text, source });
    }
  }
  if (!blocks.length) {
    const label = headerValue(header, 'contextLabel', 'context_label').replace(/[：: ]+$/u, '');
    const text = headerValue(header, 'contextText', 'context_text');
    const source = headerValue(header, 'contextSource', 'context_source');
    if (text) blocks.push({ kind: 'profile', label, text, source });
    const worldContext = headerValue(header, 'worldContextText', 'world_context_text', 'worldContext');
    if (worldContext) {
      blocks.push({
        kind: 'worldContext',
        label: 'World Context',
        text: worldContext,
        source: headerValue(header, 'worldContextSource', 'world_context_source'),
      });
    }
  }
  if (!blocks.length && String(fallbackText || '').trim()) {
    blocks.push({
      kind: 'profile',
      label: 'Profile',
      text: String(fallbackText).trim(),
      source: 'fallback',
    });
  }
  return blocks.slice(0, 4);
}

export function fullHeaderCardHeight(contextBlocks, chatMode = '') {
  const ordered = orderedContextBlocks(Array.isArray(contextBlocks) ? contextBlocks : []);
  if (!ordered.length) return HEADER_CARD_HEIGHT_NO_CONTEXT;
  const hasProfileRow = ordered.some((block) => ['agent', 'human'].includes(contextCardRole(block)));
  const detailCount = ordered.filter((block) => !['agent', 'human'].includes(contextCardRole(block))).length;
  const profileCount = ordered.filter((block) => ['agent', 'human'].includes(contextCardRole(block))).length;
  let contentHeight;
  if (hasProfileRow && chatMode === 'direct') {
    contentHeight = profileCount * PROFILE_CARD_HEIGHT;
    contentHeight += Math.max(0, profileCount - 1) * PROFILE_CARD_STACK_GAP;
  } else {
    contentHeight = hasProfileRow ? PROFILE_CARD_HEIGHT : 0;
  }
  if (hasProfileRow && detailCount) contentHeight += PROFILE_TO_CONTEXT_GAP;
  if (detailCount) {
    contentHeight += detailCount * CONTEXT_CARD_HEIGHT;
    contentHeight += Math.max(0, detailCount - 1) * CONTEXT_CARD_GAP;
  }
  return Math.min(HEADER_CARD_HEIGHT_FULL, CONTEXT_CARDS_TOP + contentHeight + 32);
}

export function transcriptHeaderHeight({ compact = false, header = null, subtitle = '' } = {}) {
  const cardHeight = compact
    ? HEADER_CARD_HEIGHT_COMPACT
    : fullHeaderCardHeight(
      headerContextBlocks(header, header ? '' : subtitle),
      headerValue(header, 'chatMode', 'chat_mode', 'mode').toLowerCase(),
    );
  return HEADER_Y + cardHeight + HEADER_BOTTOM_PAD;
}

function positions(width, bubbleWidth, label, side) {
  const currentLabelWidth = labelWidth(label);
  const inset = CANVAS_MARGIN + 38;
  if (side === 'right') {
    const bubbleX = width - inset - bubbleWidth;
    return {
      bubbleX,
      labelX: bubbleX + bubbleWidth - currentLabelWidth - 16,
      labelWidth: currentLabelWidth,
      align: 'right',
    };
  }
  const bubbleX = inset;
  return {
    bubbleX,
    labelX: bubbleX + 16,
    labelWidth: currentLabelWidth,
    align: 'left',
  };
}

function splitMeasuredMessageItem(item, maxHeight) {
  if (item.kind !== 'message' || item.height <= maxHeight) return [item];
  const fixedHeight = LABEL_HEIGHT - LABEL_OVERLAP + BUBBLE_PAD_Y * 2 + 10;
  const plainLineLimit = Math.max(1, Math.floor((maxHeight - fixedHeight) / LINE_HEIGHT));
  const finalLineLimit = Math.max(
    1,
    Math.floor((maxHeight - fixedHeight - item.tagHeight) / LINE_HEIGHT),
  );
  const remaining = [...item.lines];
  const chunks = [];
  while (remaining.length > finalLineLimit) {
    const take = Math.max(1, Math.min(plainLineLimit, remaining.length - 1));
    chunks.push(remaining.splice(0, take));
  }
  chunks.push(remaining);
  return chunks.map((lines, index) => {
    const finalChunk = index === chunks.length - 1;
    const tagHeight = finalChunk ? item.tagHeight : 0;
    const textHeight = lines.length * LINE_HEIGHT;
    return {
      ...item,
      lines,
      height: fixedHeight + textHeight + tagHeight,
      textHeight,
      tagHeight,
      message: {
        ...item.message,
        text: lines.join('\n'),
        tags: finalChunk ? [...item.message.tags] : [],
      },
      tagRows: finalChunk ? item.tagRows : [],
    };
  });
}

export function paginateTranscriptItems(
  items,
  width,
  maxHeight,
  titleOrHeader,
  subtitle = '',
  structuredHeader = null,
) {
  const objectHeader = titleOrHeader && typeof titleOrHeader === 'object' && !Array.isArray(titleOrHeader)
    ? titleOrHeader
    : null;
  const header = structuredHeader || objectHeader;
  const title = objectHeader
    ? headerValue(objectHeader, 'topic', 'title') || 'Claworld conversation'
    : String(titleOrHeader ?? '');
  const legacySubtitle = objectHeader ? '' : String(subtitle ?? '');
  const fullHeaderHeight = transcriptHeaderHeight({ header, subtitle: legacySubtitle });
  const compactHeaderHeight = transcriptHeaderHeight({ compact: true, header, subtitle: legacySubtitle });
  const minimumMessageHeight = LABEL_HEIGHT - LABEL_OVERLAP
    + BUBBLE_PAD_Y * 2 + LINE_HEIGHT + 10;
  const fullMessageHeight = Math.max(
    minimumMessageHeight,
    maxHeight - fullHeaderHeight - BODY_TOP_GAP - PAGE_BOTTOM - TIME_ROW_HEIGHT - ITEM_GAP * 2,
  );
  const compactMessageHeight = Math.max(
    minimumMessageHeight,
    maxHeight - compactHeaderHeight - BODY_TOP_GAP - PAGE_BOTTOM - TIME_ROW_HEIGHT - ITEM_GAP * 2,
  );
  const paginationItems = [];
  let firstMessage = true;
  for (const item of items) {
    if (item.kind !== 'message') {
      paginationItems.push(item);
      continue;
    }
    paginationItems.push(...splitMeasuredMessageItem(
      item,
      firstMessage ? fullMessageHeight : compactMessageHeight,
    ));
    firstMessage = false;
  }
  const pageGroups = [[]];
  let used = fullHeaderHeight + BODY_TOP_GAP + PAGE_BOTTOM;
  paginationItems.forEach((item, index) => {
    const itemHeight = item.height + ITEM_GAP;
    let neededHeight = itemHeight;
    if (item.kind === 'time' && index + 1 < paginationItems.length) {
      neededHeight += paginationItems[index + 1].height + ITEM_GAP;
    }
    if (pageGroups.at(-1).length && used + neededHeight > maxHeight) {
      pageGroups.push([]);
      used = compactHeaderHeight + BODY_TOP_GAP + PAGE_BOTTOM;
    }
    pageGroups.at(-1).push(item);
    used += itemHeight;
  });

  const pageCount = pageGroups.length;
  return pageGroups.map((pageItems, pageIndex) => {
    const currentHeaderHeight = pageIndex ? compactHeaderHeight : fullHeaderHeight;
    let y = currentHeaderHeight + BODY_TOP_GAP;
    const layoutItems = [];
    for (const item of pageItems) {
      if (item.kind === 'ellipsis' || item.kind === 'time') {
        layoutItems.push({ kind: item.kind, y, height: item.height, label: item.label });
        y += item.height + ITEM_GAP;
        continue;
      }
      const label = labelText(item.message.participantLabel);
      const position = positions(width, item.width, label, item.message.side);
      const bubbleY = y + LABEL_HEIGHT - LABEL_OVERLAP;
      const bubbleHeight = BUBBLE_PAD_Y * 2 + item.textHeight + item.tagHeight;
      layoutItems.push({
        kind: 'message',
        y,
        ...position,
        bubbleY,
        labelY: y - LABEL_RAISE,
        label,
        width: item.width,
        bubbleHeight,
        lines: item.lines,
        message: item.message,
        tagRows: item.tagRows,
        tagHeight: item.tagHeight,
        textHeight: item.textHeight,
      });
      y += item.height + ITEM_GAP;
    }
    return {
      page: pageIndex + 1,
      width,
      height: Math.max(520, Math.min(maxHeight, y + PAGE_BOTTOM)),
      items: layoutItems,
      title,
      subtitle: legacySubtitle,
      header,
      pageCount,
      footer: 'visit claworld.love',
    };
  });
}

function pageTextValues(page) {
  const data = passportData(page);
  const values = [page.title, page.subtitle, page.footer];
  values.push(...Object.values(data).filter((value) => typeof value === 'string'));
  for (const block of data.contextBlocks) values.push(block.label, block.text);
  for (const item of page.items) {
    values.push(item.label || '', ...(item.lines || []));
    if (Array.isArray(item.message?.tags)) values.push(...item.message.tags);
  }
  return values;
}

function svgDefs(page) {
  const scriptFonts = fontCssRules(pageTextValues(page));
  return [
    '<defs>',
    `<style><![CDATA[text { font-family: ${fontFamily()}; font-weight: 700; letter-spacing: 0; } ${scriptFonts} .message-row:hover rect:last-of-type { filter: url(#comicLift); }]]></style>`,
    '<pattern id="comicGridMinor" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#BED1D8" stroke-width="1" stroke-opacity="0.62"/></pattern>',
    '<pattern id="comicGridMajor" width="128" height="128" patternUnits="userSpaceOnUse"><path d="M 128 0 L 0 0 0 128" fill="none" stroke="#AABFC8" stroke-width="1.4" stroke-opacity="0.72"/></pattern>',
    '<linearGradient id="headerAccent" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#47B6FF"/><stop offset="52%" stop-color="#FF4EB4"/><stop offset="100%" stop-color="#FF8A2A"/></linearGradient>',
    '<linearGradient id="leftAccent" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#58E58F"/><stop offset="100%" stop-color="#47B6FF"/></linearGradient>',
    '<linearGradient id="rightAccent" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#A871FF"/><stop offset="100%" stop-color="#FF4EB4"/></linearGradient>',
    '<filter id="comicLift" x="-6%" y="-16%" width="112%" height="132%"><feDropShadow dx="0" dy="2" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.14"/></filter>',
    '</defs>',
  ].join('\n');
}

export function renderInlineTextSvg(
  text,
  x,
  y,
  {
    fontSize,
    fontWeight,
    fill,
    anchor = 'start',
    className = '',
  },
) {
  const runs = textRuns(omitEmoji(text));
  const baseClasses = String(className || '').split(/\s+/u).filter(Boolean);
  if (runs.length === 1) {
    const [run, script] = runs[0];
    const classes = [...baseClasses, `font-${script}`].join(' ');
    const anchorAttribute = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
    return `<text class="${classes}" x="${fixed(x)}" y="${fixed(y)}"${anchorAttribute} font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}">${escapeXml(run)}</text>`;
  }

  const anchorAttribute = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  const spans = runs.map(([run, script]) => {
    const classes = [...baseClasses, `font-${script}`].join(' ');
    return `<tspan class="${classes}" font-weight="${fontWeight}">${escapeXml(run)}</tspan>`;
  }).join('\n');
  return `<text class="${baseClasses.join(' ')}" x="${fixed(x)}" y="${fixed(y)}"${anchorAttribute} font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}">${spans}</text>`;
}

function cleanHeaderTitle(title) {
  const clean = String(title ?? '').trim();
  return clean.startsWith('@') ? clean.slice(1) : clean;
}

export function messageCountLabel(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/u.test(raw)) return '';
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) return '';
  return `${count} ${count === 1 ? 'MSG' : 'MSGS'}`;
}

function participantsAccessibleText(peerIdentity, localIdentity, initiatedBy) {
  const peer = peerIdentity || 'Peer';
  const local = localIdentity || 'Me';
  if (initiatedBy === 'peer') return `${peer} initiated a conversation with ${local}`;
  if (initiatedBy === 'local') return `${local} initiated a conversation with ${peer}`;
  return `Conversation between ${peer} and ${local}; initiator unknown`;
}

export function passportData(page) {
  const header = page?.header && typeof page.header === 'object' ? page.header : null;
  let mode = headerValue(header, 'chatMode', 'chat_mode', 'mode').toLowerCase();
  if (!['direct', 'world'].includes(mode)) mode = 'chat';
  const worldName = headerValue(header, 'worldName', 'world_name');
  const localIdentity = headerValue(header, 'localIdentity', 'local_identity');
  const peerIdentity = headerValue(header, 'peerIdentity', 'peer_identity');
  const initiatedBy = normalizeInitiatedBy(headerValue(
    header,
    'initiatedBy',
    'initiated_by',
    'initiator',
    'requestDirection',
    'request_direction',
  ));
  let topic = headerValue(header, 'topic');
  if (!topic && header) {
    const peerName = bodyParticipantName(peerIdentity || '');
    if (peerName && worldName) topic = `${peerName} — ${worldName}`;
    else topic = peerName || worldName;
  }
  topic ||= cleanHeaderTitle(page?.title) || 'Claworld conversation';
  const contextBlocks = headerContextBlocks(header, header ? '' : String(page?.subtitle || '').trim());
  const context = contextBlocks.map((block) => (
    block.label ? `${block.label}: ${block.text}` : block.text
  )).join(' · ');
  const dateLabel = headerValue(header, 'dateLabel', 'date_label');
  const reportType = headerValue(header, 'reportType', 'report_type').toLowerCase();
  const messageLabel = messageCountLabel(headerValue(header, 'messageCount', 'message_count'));
  const countLabel = [reportType.toUpperCase(), messageLabel].filter(Boolean).join(' · ');
  return {
    mode,
    modeLabel: ['direct', 'world'].includes(mode) ? `${mode.toUpperCase()} CHAT` : 'CLAWORLD CHAT',
    topic,
    worldName,
    participants: participantsAccessibleText(peerIdentity, localIdentity, initiatedBy),
    peerIdentity: peerIdentity || 'UNKNOWN',
    localIdentity: localIdentity || 'UNKNOWN',
    initiatedBy,
    context,
    contextBlocks,
    reportType,
    dateLabel,
    countLabel,
    meta: [dateLabel, countLabel].filter(Boolean).join(' · '),
  };
}

function identityDefaultGlyphUnits(character) {
  if (/\s/u.test(character)) return 0.25;
  if (character === '…') return 1;
  if (character === 'M') return 0.9;
  if (character === 'W') return 0.96;
  if (character === 'm') return 1;
  if (character === 'w') return 0.93;
  if ('Iilj'.includes(character)) return 0.35;
  if ('ft'.includes(character)) return 0.44;
  if (character === 'r') return 0.48;
  if ('csyz'.includes(character)) return 0.55;
  if ('OQHNUDG'.includes(character)) return 0.8;
  if (/\p{Lu}/u.test(character)) return 0.72;
  if (/\p{Ll}/u.test(character)) return 0.63;
  if (/\p{Nd}/u.test(character)) return 0.62;
  return Math.max(0.5, textUnits(character) * 1.08);
}

export function identityNameRenderWidth(name, fontSize) {
  let totalUnits = 0;
  for (const cluster of graphemeClusters(name)) {
    for (const [run, script] of textRuns(cluster)) {
      if (script === 'default') {
        totalUnits += [...run].reduce((sum, character) => sum + identityDefaultGlyphUnits(character), 0);
      } else if (['cjk', 'japanese', 'korean'].includes(script)) {
        totalUnits += textUnits(run) * 1.02;
      } else {
        totalUnits += textUnits(run) * 1.16;
      }
    }
  }
  return totalUnits * fontSize;
}

export function topicRenderUnits(text) {
  return identityNameRenderWidth(text, TITLE_FONT_SIZE) / TITLE_FONT_SIZE;
}

export function ellipsizeTopicText(text, maxUnits, suffix = '…') {
  const value = omitEmoji(text);
  if (topicRenderUnits(value) <= maxUnits) return value;
  const allowed = Math.max(0, maxUnits - topicRenderUnits(suffix));
  let kept = '';
  for (const cluster of graphemeClusters(value)) {
    if (topicRenderUnits(kept + cluster) > allowed) break;
    kept += cluster;
  }
  return `${kept.trimEnd()}${suffix}`;
}

function pageLabel(page) {
  return `${page.page} / ${page.pageCount || 1}`;
}

function modeBadgeWidth(label, compact = false) {
  const fontSize = compact ? 11 : 12;
  const horizontalPad = compact ? 20 : 24;
  return Math.max(compact ? 92 : 104, Math.trunc(textUnits(label) * fontSize + horizontalPad));
}

function smallBadgeWidth(label, minimum) {
  return Math.max(minimum, Math.trunc(textUnits(label) * 12 + 24));
}

function modeBadgeSvg(x, y, mode, label, compact = false) {
  const width = modeBadgeWidth(label, compact);
  const height = compact ? 26 : 28;
  const fill = mode === 'direct'
    ? THEME.directBadge
    : mode === 'world'
      ? THEME.worldBadge
      : THEME.chatBadge;
  return [
    `<g class="mode-badge mode-${escapeXml(mode)}">`,
    `<rect x="${fixed(x + 3)}" y="${fixed(y + 3)}" width="${width}" height="${height}" rx="${fixed(height / 2)}" fill="${BLACK}"/>`,
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${width}" height="${height}" rx="${fixed(height / 2)}" fill="${fill}" stroke="${BLACK}" stroke-width="2.5"/>`,
    renderInlineTextSvg(label, x + width / 2, y + (compact ? 17.5 : 19), {
      fontSize: compact ? 11 : 12,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
    }),
    '</g>',
  ].join('\n');
}

export function secondaryBadgeSvg(x, y, width, label) {
  const clipped = ellipsizeTopicText(label, Math.max(4, (width - 22) / 12));
  return [
    '<g class="world-name-badge">',
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="25" rx="12.5" fill="#FFFFFF" fill-opacity="0.72" stroke="${BLACK}" stroke-width="2" stroke-dasharray="4 3"/>`,
    renderInlineTextSvg(clipped, x + width / 2, y + 17, {
      fontSize: 12,
      fontWeight: 800,
      fill: THEME.muted,
      anchor: 'middle',
    }),
    '</g>',
  ].join('\n');
}

function smallBadgeSvg(x, y, width, label, fill, className, accessibleLabel = '') {
  const aria = accessibleLabel ? ` role="img" aria-label="${escapeXml(accessibleLabel)}"` : '';
  return [
    `<g class="${className}"${aria}>`,
    accessibleLabel ? `<title>${escapeXml(accessibleLabel)}</title>` : '',
    `<rect x="${fixed(x + 2)}" y="${fixed(y + 3)}" width="${fixed(width)}" height="26" rx="13" fill="${BLACK}"/>`,
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="26" rx="13" fill="${fill}" stroke="${BLACK}" stroke-width="2"/>`,
    renderInlineTextSvg(label, x + width / 2, y + 18, {
      fontSize: 12,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
    }),
    '</g>',
  ].join('\n');
}

export function splitIdentity(identity) {
  const value = String(identity || '').trim();
  const markerIndex = value.lastIndexOf('#');
  if (markerIndex > 0) {
    const name = value.slice(0, markerIndex).trim();
    const code = value.slice(markerIndex + 1);
    if (name && code && !/\s/u.test(code)) return [name, `#${code}`];
  }
  return [value, ''];
}

function ellipsizeIdentityName(value, maxWidth, fontSize) {
  const name = omitEmoji(value).trim();
  if (identityNameRenderWidth(name, fontSize) <= maxWidth) return name;
  const suffix = '…';
  const suffixWidth = identityNameRenderWidth(suffix, fontSize);
  if (suffixWidth > maxWidth) return '';
  let kept = '';
  for (const cluster of graphemeClusters(name)) {
    if (identityNameRenderWidth(`${kept}${cluster}`, fontSize) + suffixWidth > maxWidth) break;
    kept += cluster;
  }
  return `${kept.trimEnd()}${suffix}`;
}

function renderIdentityTextSvg(name, code, x, nameY, codeY, nameFontSize, codeFontSize, className) {
  const parts = [
    renderInlineTextSvg(name, x, nameY, {
      fontSize: nameFontSize,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
      className: `${className}-name identity-name identity-text`,
    }),
  ];
  if (code) {
    parts.push(renderInlineTextSvg(code, x, codeY, {
      fontSize: codeFontSize,
      fontWeight: 800,
      fill: '#68645F',
      anchor: 'middle',
      className: `${className}-code identity-code identity-text`,
    }));
  }
  return parts.join('\n');
}

function renderInlineIdentitySvg(
  name,
  code,
  x,
  y,
  nameWidth,
  gap,
  nameFontSize,
  codeFontSize,
  className,
) {
  const parts = [
    renderInlineTextSvg(name, x, y, {
      fontSize: nameFontSize,
      fontWeight: 900,
      fill: BLACK,
      className: `${className}-name identity-name identity-text identity-inline`,
    }),
  ];
  if (code) {
    parts.push(renderInlineTextSvg(code, x + nameWidth + gap, y, {
      fontSize: codeFontSize,
      fontWeight: 800,
      fill: '#68645F',
      className: `${className}-code identity-code identity-text identity-inline`,
    }));
  }
  return parts.join('\n');
}

export function identityLabelSvg(x, y, width, identity, dotFill, className, compact) {
  const radius = compact ? 5 : 6;
  const dotGap = 4;
  const nameFontSize = compact ? IDENTITY_COMPACT_NAME_FONT_SIZE : IDENTITY_NAME_FONT_SIZE;
  const codeFontSize = compact ? IDENTITY_COMPACT_CODE_FONT_SIZE : IDENTITY_CODE_FONT_SIZE;
  const nameY = y + (compact ? 17 : 21);
  const codeY = y + (compact ? 32 : 40);
  const inlineY = y + (compact ? 25 : 29);
  const dotReserve = radius * 2 + dotGap + 2;
  const availablePx = Math.max(18, width - dotReserve * 2);
  const [rawName, rawCode] = splitIdentity(identity);
  const textCenterX = x + width / 2;
  const nameWidth = identityNameRenderWidth(rawName, nameFontSize);
  const codeWidth = rawCode ? identityNameRenderWidth(rawCode, codeFontSize) : 0;
  const inlineGap = rawCode ? 5 : 0;
  const inlineWidth = nameWidth + inlineGap + codeWidth;
  const useInline = inlineWidth <= availablePx;
  let dotX;
  let dotY;
  let identitySvg;
  if (useInline) {
    const textLeft = textCenterX - inlineWidth / 2;
    dotY = inlineY - (compact ? 6 : 7);
    dotX = textLeft - dotGap - radius;
    identitySvg = renderInlineIdentitySvg(
      rawName,
      rawCode,
      textLeft,
      inlineY,
      nameWidth,
      inlineGap,
      nameFontSize,
      codeFontSize,
      className,
    );
  } else {
    const visibleName = ellipsizeIdentityName(rawName, availablePx, nameFontSize);
    const visibleCode = ellipsizeText(rawCode, availablePx / codeFontSize, '…');
    const visibleNameWidth = identityNameRenderWidth(visibleName, nameFontSize);
    dotY = y + (compact ? 10 : 15);
    dotX = textCenterX - visibleNameWidth / 2 - dotGap - radius;
    identitySvg = renderIdentityTextSvg(
      visibleName,
      visibleCode,
      textCenterX,
      nameY,
      codeY,
      nameFontSize,
      codeFontSize,
      className,
    );
  }
  return [
    `<g class="identity-label ${className}">`,
    `<title>${escapeXml(identity)}</title>`,
    `<circle cx="${fixed(dotX)}" cy="${fixed(dotY)}" r="${radius}" fill="${dotFill}" stroke="${BLACK}" stroke-width="2"/>`,
    identitySvg,
    '</g>',
  ].join('\n');
}

export function identityRouteSvg(x, y, width, peerIdentity, localIdentity, initiatedBy, compact = false) {
  const height = compact ? 38 : 44;
  const gap = compact ? 8 : 12;
  const centerWidth = compact ? 42 : 46;
  const routeCenter = x + width / 2;
  const centerX = routeCenter - centerWidth / 2;
  const peerWidth = Math.max(48, centerX - gap - x);
  const localX = centerX + centerWidth + gap;
  const localWidth = Math.max(48, x + width - localX);
  const [relationLabel, accessibleRelation] = initiatedBy === 'peer'
    ? ['→', 'Peer initiated the conversation with Me']
    : initiatedBy === 'local'
      ? ['←', 'Me initiated the conversation with Peer']
      : ['↔', 'The conversation initiator is unknown'];
  const accessible = `${accessibleRelation}. Peer: ${peerIdentity || 'Peer'}. Me: ${localIdentity || 'Me'}.`;
  const relationHeight = compact ? 24 : 26;
  const relationY = y + (height - relationHeight) / 2;
  return [
    `<g class="conversation-participants identity-route" role="img" aria-label="${escapeXml(accessible)}">`,
    `<title>${escapeXml(accessible)}</title>`,
    identityLabelSvg(x, y, peerWidth, peerIdentity || 'UNKNOWN', THEME.leftLabel, 'identity-peer', compact),
    `<rect x="${fixed(centerX + 2)}" y="${fixed(relationY + 3)}" width="${fixed(centerWidth)}" height="${relationHeight}" rx="${fixed(relationHeight / 2)}" fill="${BLACK}"/>`,
    `<rect class="conversation-relation relation-${initiatedBy || 'unknown'}" x="${fixed(centerX)}" y="${fixed(relationY)}" width="${fixed(centerWidth)}" height="${relationHeight}" rx="${fixed(relationHeight / 2)}" fill="#FFFFFF" stroke="${BLACK}" stroke-width="2"/>`,
    renderInlineTextSvg(relationLabel, centerX + centerWidth / 2, relationY + (compact ? 17 : 19), {
      fontSize: compact ? 15 : 17,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
      className: 'conversation-relation-label',
    }),
    identityLabelSvg(localX, y, localWidth, localIdentity || 'UNKNOWN', THEME.rightLabel, 'identity-local', compact),
    '</g>',
  ].join('\n');
}

export function contextCardRole(block) {
  const kind = String(block?.kind || '').trim();
  if (['peerAgentProfile', 'peerGlobalProfile', 'agentProfile'].includes(kind)) return 'agent';
  if (['peerHumanProfile', 'humanProfile'].includes(kind)) return 'human';
  if (['worldContext', 'worldIdentity'].includes(kind)) return 'world';
  if (['peerWorldMembershipProfile', 'peerWorldProfile', 'worldAgentProfile'].includes(kind)) return 'role';
  return 'detail';
}

export function orderedContextBlocks(blocks) {
  const order = { agent: 0, human: 1, world: 2, role: 3, detail: 4 };
  return [...blocks]
    .map((block, index) => ({ block, index }))
    .sort((left, right) => (
      order[contextCardRole(left.block)] - order[contextCardRole(right.block)]
      || left.index - right.index
    ))
    .slice(0, 4)
    .map(({ block }) => block);
}

export function contextCardLabel(kind, fallback) {
  return {
    agent: 'About this agent',
    human: 'About their human',
    world: 'About this world',
    role: 'Their role here',
  }[contextCardRole({ kind })] || String(fallback || 'Profile').trim();
}

export function contextCardAccent(role) {
  return {
    human: THEME.directBadge,
    world: THEME.worldBadge,
    role: THEME.roleBadge,
  }[role] || THEME.leftLabel;
}

export function contextFieldIconSvg(cx, cy, kind) {
  const role = contextCardRole({ kind });
  const fill = contextCardAccent(role);
  if (role === 'world') {
    return [
      '<g class="context-icon context-icon-world">',
      `<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="5.5" fill="${fill}" stroke="${BLACK}" stroke-width="1.2"/>`,
      `<path d="M${fixed(cx - 4.7)} ${fixed(cy)} H${fixed(cx + 4.7)} M${fixed(cx)} ${fixed(cy - 4.7)} C${fixed(cx - 2.4)} ${fixed(cy - 1.6)}, ${fixed(cx - 2.4)} ${fixed(cy + 1.6)}, ${fixed(cx)} ${fixed(cy + 4.7)} M${fixed(cx)} ${fixed(cy - 4.7)} C${fixed(cx + 2.4)} ${fixed(cy - 1.6)}, ${fixed(cx + 2.4)} ${fixed(cy + 1.6)}, ${fixed(cx)} ${fixed(cy + 4.7)}" fill="none" stroke="${BLACK}" stroke-width="0.9" stroke-linecap="round"/>`,
      '</g>',
    ].join('\n');
  }
  if (role === 'role') {
    return [
      '<g class="context-icon context-icon-role">',
      `<path d="M${fixed(cx)} ${fixed(cy + 6.2)} C${fixed(cx - 4)} ${fixed(cy + 1.7)}, ${fixed(cx - 5.5)} ${fixed(cy - 0.8)}, ${fixed(cx - 5.5)} ${fixed(cy - 3.2)} A5.5 5.5 0 1 1 ${fixed(cx + 5.5)} ${fixed(cy - 3.2)} C${fixed(cx + 5.5)} ${fixed(cy - 0.8)}, ${fixed(cx + 4)} ${fixed(cy + 1.7)}, ${fixed(cx)} ${fixed(cy + 6.2)} Z" fill="${fill}" stroke="${BLACK}" stroke-width="1.2" stroke-linejoin="round"/>`,
      `<circle cx="${fixed(cx)}" cy="${fixed(cy - 3.2)}" r="1.7" fill="${THEME.passportStrip}" stroke="${BLACK}" stroke-width="0.9"/>`,
      '</g>',
    ].join('\n');
  }
  if (role === 'agent') {
    return [
      '<g class="context-icon context-icon-agent">',
      `<line x1="${fixed(cx)}" y1="${fixed(cy - 6.2)}" x2="${fixed(cx)}" y2="${fixed(cy - 4)}" stroke="${BLACK}" stroke-width="1.1"/>`,
      `<circle cx="${fixed(cx)}" cy="${fixed(cy - 7.2)}" r="1.1" fill="${fill}" stroke="${BLACK}" stroke-width="0.8"/>`,
      `<rect x="${fixed(cx - 5.5)}" y="${fixed(cy - 4)}" width="11" height="9" rx="2.4" fill="${fill}" stroke="${BLACK}" stroke-width="1.2"/>`,
      `<circle cx="${fixed(cx - 2.3)}" cy="${fixed(cy)}" r="0.9" fill="${BLACK}"/><circle cx="${fixed(cx + 2.3)}" cy="${fixed(cy)}" r="0.9" fill="${BLACK}"/>`,
      '</g>',
    ].join('\n');
  }
  return [
    '<g class="context-icon context-icon-human">',
    `<circle cx="${fixed(cx)}" cy="${fixed(cy - 3.2)}" r="3.2" fill="${fill}" stroke="${BLACK}" stroke-width="1.2"/>`,
    `<path d="M${fixed(cx - 5.5)} ${fixed(cy + 5.5)} C${fixed(cx - 5.5)} ${fixed(cy + 1)}, ${fixed(cx - 3.2)} ${fixed(cy)}, ${fixed(cx)} ${fixed(cy)} C${fixed(cx + 3.2)} ${fixed(cy)}, ${fixed(cx + 5.5)} ${fixed(cy + 1)}, ${fixed(cx + 5.5)} ${fixed(cy + 5.5)} Z" fill="${fill}" stroke="${BLACK}" stroke-width="1.2" stroke-linejoin="round"/>`,
    '</g>',
  ].join('\n');
}

export function boundedContextLines(text, contentWidth) {
  const value = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!value) return [];
  let maxUnits = Math.max(4, contentWidth / CONTEXT_TEXT_FONT_SIZE);
  if (isLatinText(value)) maxUnits /= 0.82;
  const lines = wrapText(value, maxUnits);
  const visible = lines.slice(0, CONTEXT_TEXT_MAX_LINES);
  if (lines.length > CONTEXT_TEXT_MAX_LINES && visible.length) {
    const lastIndex = visible.length - 1;
    const last = ellipsizeText(visible[lastIndex], Math.max(0, maxUnits - textUnits('…')), '').trimEnd();
    visible[lastIndex] = last ? `${last}…` : '…';
  }
  return visible;
}

function isLatinText(value) {
  const runs = textRuns(value).filter(([run]) => run.trim());
  return runs.length > 0
    && runs.every(([, script]) => script === 'default')
    && /\p{Letter}/u.test(value);
}

export function renderContextCard(x, y, width, block, compact = false) {
  const kind = String(block?.kind || 'profile');
  const label = contextCardLabel(kind, block?.label);
  const text = String(block?.text || '').replace(/\s+/gu, ' ').trim();
  const cardHeight = compact ? PROFILE_CARD_HEIGHT : CONTEXT_CARD_HEIGHT;
  const contentX = x + 27;
  const contentWidth = Math.max(48, width - 54);
  const lines = boundedContextLines(text, contentWidth);
  const classKind = kind.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/gu, '') || 'profile';
  const role = contextCardRole(block);
  const accent = contextCardAccent(role);
  const accessibleText = ellipsizeText(text, 120, '…');
  const accessible = accessibleText ? `${label}: ${accessibleText}` : label;
  const legendWidth = Math.max(
    64,
    Math.min(width - 40, 40 + identityNameRenderWidth(label, CONTEXT_LABEL_FONT_SIZE)),
  );
  const parts = [
    `<g class="passport-context-field context-${classKind}" role="group" aria-label="${escapeXml(accessible)}">`,
    `<title>${escapeXml(accessible)}</title>`,
    `<rect x="${fixed(x + 3)}" y="${fixed(y + 3)}" width="${fixed(width)}" height="${cardHeight}" rx="15" fill="${BLACK}"/>`,
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${cardHeight}" rx="15" fill="${THEME.passportStrip}" stroke="${BLACK}" stroke-width="2.5"/>`,
    `<rect x="${fixed(x + 8)}" y="${fixed(y + 10)}" width="6" height="${cardHeight - 20}" rx="3" fill="${accent}"/>`,
    `<rect class="context-field-legend" x="${fixed(x + 20)}" y="${fixed(y - 12.5)}" width="${fixed(legendWidth)}" height="${CONTEXT_LEGEND_HEIGHT}" rx="${fixed(CONTEXT_LEGEND_HEIGHT / 2)}" fill="${THEME.passportStrip}" stroke="${BLACK}" stroke-width="2.2"/>`,
    contextFieldIconSvg(x + 35, y + 0.5, kind),
    renderInlineTextSvg(label, x + 52, y + 4.5, {
      fontSize: CONTEXT_LABEL_FONT_SIZE,
      fontWeight: 900,
      fill: '#68645F',
      className: 'context-field-label',
    }),
  ];
  const contentStartY = y + cardHeight / 2 + CONTEXT_TEXT_BASELINE_CENTER_OFFSET
    - Math.max(0, lines.length - 1) * CONTEXT_TEXT_LINE_HEIGHT / 2;
  lines.forEach((line, index) => {
    parts.push(renderInlineTextSvg(line, contentX, contentStartY + index * CONTEXT_TEXT_LINE_HEIGHT, {
      fontSize: CONTEXT_TEXT_FONT_SIZE,
      fontWeight: 800,
      fill: THEME.muted,
      className: 'conversation-context context-field-text',
    }));
  });
  parts.push('</g>');
  return parts.join('\n');
}

export function renderContextCards(x, y, width, blocks, verticalProfiles = false) {
  const ordered = orderedContextBlocks(blocks);
  const profileBlocks = ordered.filter((block) => ['agent', 'human'].includes(contextCardRole(block)));
  const detailBlocks = ordered.filter((block) => !['agent', 'human'].includes(contextCardRole(block)));
  const parts = [];
  let nextY = y;
  if (profileBlocks.length) {
    const byRole = new Map(profileBlocks.map((block) => [contextCardRole(block), block]));
    const visibleProfiles = ['agent', 'human'].map((role) => byRole.get(role)).filter(Boolean);
    if (verticalProfiles) {
      visibleProfiles.forEach((block, index) => {
        parts.push(renderContextCard(
          x,
          y + index * (PROFILE_CARD_HEIGHT + PROFILE_CARD_STACK_GAP),
          width,
          block,
          true,
        ));
      });
      nextY += visibleProfiles.length * PROFILE_CARD_HEIGHT;
      nextY += Math.max(0, visibleProfiles.length - 1) * PROFILE_CARD_STACK_GAP;
    } else {
      const cardWidth = (width - PROFILE_CARD_GAP) / 2;
      visibleProfiles.forEach((block, index) => {
        parts.push(renderContextCard(
          x + index * (cardWidth + PROFILE_CARD_GAP),
          y,
          cardWidth,
          block,
          true,
        ));
      });
      nextY += PROFILE_CARD_HEIGHT;
    }
    if (detailBlocks.length) nextY += PROFILE_TO_CONTEXT_GAP;
  }
  for (const block of detailBlocks) {
    parts.push(renderContextCard(x, nextY, width, block));
    nextY += CONTEXT_CARD_HEIGHT + CONTEXT_CARD_GAP;
  }
  return parts.join('\n');
}

export function renderFullHeader(page) {
  const x = CANVAS_MARGIN + 26;
  const y = HEADER_Y;
  const width = page.width - (CANVAS_MARGIN + 26) * 2;
  const data = passportData(page);
  const height = fullHeaderCardHeight(data.contextBlocks, data.mode);
  const modeWidth = modeBadgeWidth(data.modeLabel);
  const currentPageLabel = pageLabel(page);
  const pageWidth = smallBadgeWidth(currentPageLabel, 48);
  const countWidth = data.countLabel ? smallBadgeWidth(data.countLabel, 48) : 0;
  const rightEdge = x + width - 20;
  const pageX = rightEdge - pageWidth;
  const countX = pageX - countWidth - (data.countLabel ? 8 : 0);
  const secondaryX = x + 20 + modeWidth + 10;
  const secondaryRight = data.countLabel ? countX - 10 : pageX - 10;
  const secondaryWidth = Math.max(0, secondaryRight - secondaryX);
  const topicCenterX = x + width / 2;
  const topicClipX = x + HEADER_TOPIC_SIDE_PADDING;
  const topicClipWidth = Math.max(0, width - HEADER_TOPIC_SIDE_PADDING * 2);
  const topicClipId = `conversation-topic-clip-${page.page}`;
  const topicMaxUnits = Math.max(
    8,
    Math.min(HEADER_TOPIC_MAX_UNITS, topicClipWidth / TITLE_FONT_SIZE),
  );
  const topic = ellipsizeTopicText(data.topic, topicMaxUnits);
  const parts = [
    '<g class="conversation-passport conversation-passport-full">',
    `<rect x="${x + 11}" y="${y + 7}" width="${width + 2}" height="${height + 10}" rx="24" fill="${BLACK}"/>`,
    `<rect x="${x + 7}" y="${y + 6}" width="${width}" height="${height + 4}" rx="24" fill="url(#headerAccent)"/>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="${THEME.headerFill}" stroke="${BLACK}" stroke-width="4"/>`,
    modeBadgeSvg(x + 20, y + 14, data.mode, data.modeLabel),
  ];
  if (secondaryWidth >= 54) {
    parts.push(secondaryBadgeSvg(secondaryX, y + 16, secondaryWidth, data.worldName || 'CLAWORLD CHAT'));
  }
  if (data.countLabel) {
    parts.push(smallBadgeSvg(countX, y + 15, countWidth, data.countLabel, '#FFFFFF', 'message-count-badge', data.countLabel));
  }
  parts.push(smallBadgeSvg(pageX, y + 15, pageWidth, currentPageLabel, '#F1E5FF', 'page-badge'));
  parts.push(
    `<defs><clipPath id="${topicClipId}"><rect x="${fixed(topicClipX)}" y="${fixed(y + 50)}" width="${fixed(topicClipWidth)}" height="40"/></clipPath></defs>`,
    `<g clip-path="url(#${topicClipId})">`,
    renderInlineTextSvg(topic, topicCenterX, y + 80, {
      fontSize: TITLE_FONT_SIZE,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
      className: 'conversation-topic',
    }),
    '</g>',
  );
  parts.push(identityRouteSvg(
    x + 18,
    y + 96,
    width - 36,
    data.peerIdentity,
    data.localIdentity,
    data.initiatedBy,
  ));
  if (data.contextBlocks.length) {
    parts.push(renderContextCards(
      x + 18,
      y + CONTEXT_CARDS_TOP,
      width - 36,
      data.contextBlocks,
      data.mode === 'direct',
    ));
  }
  parts.push('</g>');
  return parts.join('\n');
}

export function renderCompactHeader(page) {
  const x = CANVAS_MARGIN + 26;
  const y = HEADER_Y;
  const width = page.width - (CANVAS_MARGIN + 26) * 2;
  const data = passportData(page);
  const modeWidth = modeBadgeWidth(data.modeLabel, true);
  const currentPageLabel = pageLabel(page);
  const pageWidth = smallBadgeWidth(currentPageLabel, 48);
  const topicX = x + 18 + modeWidth + 12;
  const topicRight = x + width - 18 - pageWidth - 12;
  const topicClipWidth = Math.max(0, topicRight - topicX);
  const topicClipId = `conversation-topic-clip-${page.page}`;
  const topicUnits = Math.max(9, Math.min(HEADER_COMPACT_TOPIC_MAX_UNITS, (topicRight - topicX) / 18));
  const topic = ellipsizeText(data.topic, topicUnits, '…');
  return [
    '<g class="conversation-passport conversation-passport-compact">',
    `<rect x="${x + 9}" y="${y + 6}" width="${width + 1}" height="${HEADER_CARD_HEIGHT_COMPACT + 7}" rx="20" fill="${BLACK}"/>`,
    `<rect x="${x + 6}" y="${y + 5}" width="${width}" height="${HEADER_CARD_HEIGHT_COMPACT + 2}" rx="20" fill="url(#headerAccent)"/>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${HEADER_CARD_HEIGHT_COMPACT}" rx="20" fill="${THEME.headerFill}" stroke="${BLACK}" stroke-width="4"/>`,
    modeBadgeSvg(x + 18, y + 12, data.mode, data.modeLabel, true),
    `<defs><clipPath id="${topicClipId}"><rect x="${fixed(topicX)}" y="${fixed(y + 8)}" width="${fixed(topicClipWidth)}" height="38"/></clipPath></defs>`,
    `<g clip-path="url(#${topicClipId})">`,
    renderInlineTextSvg(topic, topicX, y + 35, {
      fontSize: 18,
      fontWeight: 900,
      fill: BLACK,
      className: 'conversation-topic',
    }),
    '</g>',
    smallBadgeSvg(x + width - 18 - pageWidth, y + 12, pageWidth, currentPageLabel, '#F1E5FF', 'page-badge'),
    identityRouteSvg(x + 18, y + 50, width - 36, data.peerIdentity, data.localIdentity, data.initiatedBy, true),
    '</g>',
  ].join('\n');
}

export function renderHeader(page) {
  return page.page > 1 ? renderCompactHeader(page) : renderFullHeader(page);
}

function diamondSvg(cx, cy, radius, fill) {
  const shadow = `<polygon points="${fixed(cx + 1)},${fixed(cy + 2 - radius)} ${fixed(cx + 1 + radius * 0.46)},${fixed(cy + 2)} ${fixed(cx + 1)},${fixed(cy + 2 + radius)} ${fixed(cx + 1 - radius * 0.46)},${fixed(cy + 2)}" fill="${BLACK}" stroke="${BLACK}" stroke-width="2.5"/>`;
  const front = `<polygon points="${fixed(cx)},${fixed(cy - radius)} ${fixed(cx + radius * 0.46)},${fixed(cy)} ${fixed(cx)},${fixed(cy + radius)} ${fixed(cx - radius * 0.46)},${fixed(cy)}" fill="${fill}" stroke="${BLACK}" stroke-width="2.5"/>`;
  return `${shadow}\n${front}`;
}

function renderTimeSvg(page, item) {
  const label = clipDisplay(item.label, 22);
  const labelWidthValue = Math.max(150, displayCols(label) * 8 + 44);
  const x = page.width / 2 - labelWidthValue / 2;
  const y = item.y + 4;
  return [
    '<g class="time-row">',
    diamondSvg(x - 28, y + 16, 13, '#FF5BE2'),
    `<rect x="${fixed(x + 3)}" y="${y + 4}" width="${labelWidthValue}" height="30" rx="15" fill="${BLACK}"/>`,
    `<rect x="${fixed(x)}" y="${y}" width="${labelWidthValue}" height="30" rx="15" fill="${THEME.timeFill}" stroke="${BLACK}" stroke-width="3"/>`,
    renderInlineTextSvg(label, page.width / 2, y + 21, {
      fontSize: FONT_SIZE,
      fontWeight: 700,
      fill: BLACK,
      anchor: 'middle',
    }),
    diamondSvg(x + labelWidthValue + 28, y + 16, 13, '#5FE0A7'),
    '</g>',
  ].join('\n');
}

function sideColors(side) {
  return side === 'right'
    ? { fill: THEME.rightFill, label: THEME.rightLabel, accent: 'url(#rightAccent)' }
    : { fill: THEME.leftFill, label: THEME.leftLabel, accent: 'url(#leftAccent)' };
}

function bubbleLayersSvg(item, colors) {
  const { bubbleX: x, bubbleY: y, width, bubbleHeight: height } = item;
  return [
    `<rect x="${x + 11}" y="${y + 9}" width="${width + 2}" height="${height + 4}" rx="17" fill="${BLACK}"/>`,
    `<rect x="${x + 11}" y="${y + 9}" width="${width - 3}" height="${height}" rx="17" fill="${colors.accent}" stroke="${BLACK}" stroke-width="3"/>`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="17" fill="${colors.fill}" stroke="${BLACK}" stroke-width="4"/>`,
  ].join('\n');
}

function thumbIconSvg(x, y, accent, down = false) {
  const paths = [
    `<path d="M${fixed(x + 7.8)} ${fixed(y + 13.3)} H${fixed(x + 12)} V${fixed(y + 24)} H${fixed(x + 7.8)} Z" fill="#FFFFFF" stroke="${BLACK}" stroke-width="2" stroke-linejoin="round"/>`,
    `<path d="M${fixed(x + 12)} ${fixed(y + 23.6)} H${fixed(x + 21.2)} C${fixed(x + 23)} ${fixed(y + 23.6)} ${fixed(x + 24)} ${fixed(y + 22.5)} ${fixed(x + 24.4)} ${fixed(y + 20.9)} L${fixed(x + 25.4)} ${fixed(y + 15.6)} C${fixed(x + 25.8)} ${fixed(y + 13.9)} ${fixed(x + 24.5)} ${fixed(y + 12.2)} ${fixed(x + 22.7)} ${fixed(y + 12.2)} H${fixed(x + 18.6)} L${fixed(x + 19.2)} ${fixed(y + 9.1)} C${fixed(x + 19.5)} ${fixed(y + 7.4)} ${fixed(x + 18.4)} ${fixed(y + 5.7)} ${fixed(x + 16.7)} ${fixed(y + 5.4)} L${fixed(x + 15.8)} ${fixed(y + 5.3)} L${fixed(x + 12)} ${fixed(y + 12.9)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="2" stroke-linejoin="round"/>`,
  ].join('\n');
  if (!down) return paths;
  const centerX = x + TAG_ICON_SIZE / 2;
  const centerY = y + TAG_ICON_SIZE / 2;
  return `<g transform="rotate(180 ${fixed(centerX)} ${fixed(centerY)})">\n${paths}\n</g>`;
}

function requestEndIconSvg(x, y, accent) {
  return [
    `<path d="M${fixed(x + 22)} ${fixed(y + 4)} C${fixed(x + 25.2)} ${fixed(y + 5.4)} ${fixed(x + 26.6)} ${fixed(y + 7.8)} ${fixed(x + 26.5)} ${fixed(y + 10.6)}" fill="none" stroke="${BLACK}" stroke-width="2" stroke-linecap="round"/>`,
    `<path d="M${fixed(x + 9.215, 3)} ${fixed(y + 18.117, 3)} C${fixed(x + 10.043, 3)} ${fixed(y + 22.457, 3)} ${fixed(x + 13.384, 3)} ${fixed(y + 25.036, 3)} ${fixed(x + 17.132, 3)} ${fixed(y + 23.961, 3)} L${fixed(x + 19.44, 3)} ${fixed(y + 23.3, 3)} C${fixed(x + 22.323, 3)} ${fixed(y + 22.473, 3)} ${fixed(x + 23.488, 3)} ${fixed(y + 19.642, 3)} ${fixed(x + 22.538, 3)} ${fixed(y + 16.69, 3)} L${fixed(x + 21.435, 3)} ${fixed(y + 12.845, 3)} L${fixed(x + 9.227, 3)} ${fixed(y + 16.345, 3)} L${fixed(x + 9.215, 3)} ${fixed(y + 18.117, 3)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="2" stroke-linejoin="round"/>`,
    `<path d="M${fixed(x + 9.665, 3)} ${fixed(y + 7.897, 3)} L${fixed(x + 9.473, 3)} ${fixed(y + 7.952, 3)} C${fixed(x + 8.756, 3)} ${fixed(y + 8.158, 3)} ${fixed(x + 8.286, 3)} ${fixed(y + 8.709, 3)} ${fixed(x + 8.422, 3)} ${fixed(y + 9.184, 3)} L${fixed(x + 10.192, 3)} ${fixed(y + 15.356, 3)} C${fixed(x + 10.328, 3)} ${fixed(y + 15.831, 3)} ${fixed(x + 11.019, 3)} ${fixed(y + 16.049, 3)} ${fixed(x + 11.736, 3)} ${fixed(y + 15.843, 3)} L${fixed(x + 11.928, 3)} ${fixed(y + 15.788, 3)} C${fixed(x + 12.645, 3)} ${fixed(y + 15.583, 3)} ${fixed(x + 13.115, 3)} ${fixed(y + 15.031, 3)} ${fixed(x + 12.979, 3)} ${fixed(y + 14.557, 3)} L${fixed(x + 11.209, 3)} ${fixed(y + 8.384, 3)} C${fixed(x + 11.073, 3)} ${fixed(y + 7.91, 3)} ${fixed(x + 10.382, 3)} ${fixed(y + 7.692, 3)} ${fixed(x + 9.665, 3)} ${fixed(y + 7.897, 3)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="1.8"/>`,
    `<path d="M${fixed(x + 11.93, 3)} ${fixed(y + 5.999, 3)} L${fixed(x + 11.738, 3)} ${fixed(y + 6.055, 3)} C${fixed(x + 11.021, 3)} ${fixed(y + 6.26, 3)} ${fixed(x + 10.553, 3)} ${fixed(y + 6.82, 3)} ${fixed(x + 10.692, 3)} ${fixed(y + 7.306, 3)} L${fixed(x + 12.729, 3)} ${fixed(y + 14.408, 3)} C${fixed(x + 12.868, 3)} ${fixed(y + 14.894, 3)} ${fixed(x + 13.562, 3)} ${fixed(y + 15.122, 3)} ${fixed(x + 14.279, 3)} ${fixed(y + 14.916, 3)} L${fixed(x + 14.471, 3)} ${fixed(y + 14.861, 3)} C${fixed(x + 15.188, 3)} ${fixed(y + 14.655, 3)} ${fixed(x + 15.656, 3)} ${fixed(y + 14.095, 3)} ${fixed(x + 15.516, 3)} ${fixed(y + 13.609, 3)} L${fixed(x + 13.48, 3)} ${fixed(y + 6.507, 3)} C${fixed(x + 13.341, 3)} ${fixed(y + 6.021, 3)} ${fixed(x + 12.647, 3)} ${fixed(y + 5.794, 3)} ${fixed(x + 11.93, 3)} ${fixed(y + 5.999, 3)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="1.8"/>`,
    `<path d="M${fixed(x + 14.636, 3)} ${fixed(y + 5.64, 3)} L${fixed(x + 14.443, 3)} ${fixed(y + 5.695, 3)} C${fixed(x + 13.727, 3)} ${fixed(y + 5.9, 3)} ${fixed(x + 13.258, 3)} ${fixed(y + 6.457, 3)} ${fixed(x + 13.396, 3)} ${fixed(y + 6.938, 3)} L${fixed(x + 15.338, 3)} ${fixed(y + 13.714, 3)} C${fixed(x + 15.476, 3)} ${fixed(y + 14.195, 3)} ${fixed(x + 16.169, 3)} ${fixed(y + 14.418, 3)} ${fixed(x + 16.886, 3)} ${fixed(y + 14.213, 3)} L${fixed(x + 17.078, 3)} ${fixed(y + 14.157, 3)} C${fixed(x + 17.795, 3)} ${fixed(y + 13.952, 3)} ${fixed(x + 18.264, 3)} ${fixed(y + 13.395, 3)} ${fixed(x + 18.126, 3)} ${fixed(y + 12.914, 3)} L${fixed(x + 16.183, 3)} ${fixed(y + 6.139, 3)} C${fixed(x + 16.045, 3)} ${fixed(y + 5.658, 3)} ${fixed(x + 15.352, 3)} ${fixed(y + 5.434, 3)} ${fixed(x + 14.636, 3)} ${fixed(y + 5.64, 3)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="1.8"/>`,
    `<path d="M${fixed(x + 17.8, 3)} ${fixed(y + 6.085, 3)} L${fixed(x + 17.702, 3)} ${fixed(y + 6.113, 3)} C${fixed(x + 16.971, 3)} ${fixed(y + 6.322, 3)} ${fixed(x + 16.482, 3)} ${fixed(y + 6.851, 3)} ${fixed(x + 16.609, 3)} ${fixed(y + 7.294, 3)} L${fixed(x + 18.176, 3)} ${fixed(y + 12.759, 3)} C${fixed(x + 18.303, 3)} ${fixed(y + 13.202, 3)} ${fixed(x + 18.998, 3)} ${fixed(y + 13.391, 3)} ${fixed(x + 19.729, 3)} ${fixed(y + 13.182, 3)} L${fixed(x + 19.827, 3)} ${fixed(y + 13.154, 3)} C${fixed(x + 20.557, 3)} ${fixed(y + 12.944, 3)} ${fixed(x + 21.046, 3)} ${fixed(y + 12.415, 3)} ${fixed(x + 20.919, 3)} ${fixed(y + 11.972, 3)} L${fixed(x + 19.352, 3)} ${fixed(y + 6.507, 3)} C${fixed(x + 19.225, 3)} ${fixed(y + 6.065, 3)} ${fixed(x + 18.53, 3)} ${fixed(y + 5.875, 3)} ${fixed(x + 17.8, 3)} ${fixed(y + 6.085, 3)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="1.8"/>`,
    `<path d="M${fixed(x + 9.546, 3)} ${fixed(y + 19.999, 3)} L${fixed(x + 6, 3)} ${fixed(y + 17.791, 3)} C${fixed(x + 4.736, 3)} ${fixed(y + 17.009, 3)} ${fixed(x + 5.668, 3)} ${fixed(y + 15.181, 3)} ${fixed(x + 7.138, 3)} ${fixed(y + 15.592, 3)} L${fixed(x + 10.615, 3)} ${fixed(y + 17.196, 3)} L${fixed(x + 9.546, 3)} ${fixed(y + 19.999, 3)} Z" fill="${accent}" stroke="${BLACK}" stroke-width="1.8" stroke-linejoin="round"/>`,
    `<rect x="${fixed(x + 10.887, 3)}" y="${fixed(y + 14.834, 3)}" width="9.584" height="3.800" transform="rotate(-16.9438 ${fixed(x + 10.887, 3)} ${fixed(y + 14.834, 3)})" fill="${accent}"/>`,
    `<path d="M${fixed(x + 10.5)} ${fixed(y + 19.5)} L${fixed(x + 11)} ${fixed(y + 20)} L${fixed(x + 11.5)} ${fixed(y + 17)} L${fixed(x + 9.5)} ${fixed(y + 17.5)} L${fixed(x + 9)} ${fixed(y + 18.5)} L${fixed(x + 10.5)} ${fixed(y + 19.5)} Z" fill="${accent}"/>`,
  ].join('\n');
}

function fallbackTagSvg(tag, x, y) {
  const label = fallbackTagLabel(tag);
  const width = tagWidth(tag);
  return [
    `<g class="tag-icon tag-fallback" role="img" aria-label="${escapeXml(label)}">`,
    `<title>${escapeXml(label)}</title>`,
    `<rect x="${fixed(x + 3)}" y="${fixed(y + 4)}" width="${width}" height="${TAG_ICON_SIZE}" rx="9" fill="${BLACK}"/>`,
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${width}" height="${TAG_ICON_SIZE}" rx="9" fill="#F6F1FF" stroke="${BLACK}" stroke-width="2.5"/>`,
    renderInlineTextSvg(label, x + width / 2, y + 20.5, {
      fontSize: LABEL_FONT_SIZE,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
    }),
    '</g>',
  ].join('\n');
}

function tagIconSvg(tag, x, y) {
  const normalized = tagName(tag);
  if (!['like', 'dislike', 'request end'].includes(normalized)) {
    return fallbackTagSvg(normalized, x, y);
  }
  const [fill, accent] = TAG_ICON_THEMES[normalized];
  const icon = normalized === 'request end'
    ? requestEndIconSvg(x, y, accent)
    : thumbIconSvg(x, y, accent, normalized === 'dislike');
  return [
    `<g class="tag-icon tag-${escapeXml(normalized.replaceAll(' ', '-'))}" role="img" aria-label="${escapeXml(normalized)}">`,
    `<title>${escapeXml(normalized)}</title>`,
    `<rect x="${fixed(x + 3)}" y="${fixed(y + 4)}" width="${TAG_ICON_SIZE}" height="${TAG_ICON_SIZE}" rx="9" fill="${BLACK}"/>`,
    `<rect x="${fixed(x)}" y="${fixed(y)}" width="${TAG_ICON_SIZE}" height="${TAG_ICON_SIZE}" rx="9" fill="${fill}" stroke="${BLACK}" stroke-width="2.5"/>`,
    icon,
    '</g>',
  ].join('\n');
}

function renderTagIconsSvg(tags, x, y) {
  const parts = [`<g class="tag-icons" transform="translate(${fixed(x)} ${fixed(y)})">`];
  let cursor = 0;
  for (const tag of tags) {
    parts.push(tagIconSvg(tag, cursor, 0));
    cursor += tagWidth(tag) + TAG_ICON_GAP;
  }
  parts.push('</g>');
  return parts.join('\n');
}

function renderTagRowsSvg(rows, x, y) {
  return rows.map((tags, index) => renderTagIconsSvg(
    tags,
    x,
    y + index * (TAG_ICON_SIZE + TAG_ROW_GAP),
  )).join('\n');
}

function renderMessageSvg(item) {
  const { message } = item;
  const colors = sideColors(message.side);
  const accessibleLabel = escapeXml(`${bodyParticipantName(message.participantLabel)}: ${message.text}`);
  const parts = [
    `<g class="message-row ${message.side}" role="listitem" aria-label="${accessibleLabel}">`,
    `<title>${accessibleLabel}</title>`,
    bubbleLayersSvg(item, colors),
    `<rect x="${item.labelX}" y="${item.labelY}" width="${item.labelWidth}" height="${LABEL_HEIGHT}" rx="9" fill="${colors.label}" stroke="${BLACK}" stroke-width="3"/>`,
    renderInlineTextSvg(item.label, item.labelX + item.labelWidth / 2, item.labelY + 21, {
      fontSize: LABEL_FONT_SIZE,
      fontWeight: 900,
      fill: BLACK,
      anchor: 'middle',
    }),
  ];
  const textX = item.bubbleX + BUBBLE_PAD_X;
  let textY = item.bubbleY + BUBBLE_PAD_Y + 17;
  for (const line of item.lines) {
    parts.push(renderInlineTextSvg(line, textX, textY, {
      fontSize: FONT_SIZE,
      fontWeight: 800,
      fill: BLACK,
    }));
    textY += LINE_HEIGHT;
  }
  if (message.tags.length) {
    const tagRows = item.tagRows?.length
      ? item.tagRows
      : packTagRows(visibleTags(message.tags), item.width - BUBBLE_PAD_X * 2);
    parts.push(renderTagRowsSvg(tagRows, textX, textY + TAG_ICON_TOP_GAP));
  }
  parts.push('</g>');
  return parts.join('\n');
}

export function renderTranscriptPageSvg(page) {
  const titleId = `claworld-report-title-${page.page}`;
  const descriptionId = `claworld-report-desc-${page.page}`;
  const passport = passportData(page);
  const description = [
    passport.modeLabel,
    passport.topic,
    passport.participants,
    passport.context,
    passport.meta,
  ].filter(Boolean).join('. ') + `. ${page.items.length} transcript rows.`;
  const parts = [
    `<svg class="comic-grid" xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}" role="document" aria-labelledby="${titleId} ${descriptionId}">`,
    `<title id="${titleId}">${escapeXml(page.title)}</title>`,
    `<desc id="${descriptionId}">${escapeXml(description)}</desc>`,
    svgDefs(page),
    `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="${THEME.paper}"/>`,
    `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="url(#comicGridMinor)"/>`,
    `<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="url(#comicGridMajor)" opacity="0.46"/>`,
    `<rect x="${FRAME_MARGIN}" y="${FRAME_MARGIN}" width="${page.width - FRAME_MARGIN * 2}" height="${page.height - FRAME_MARGIN * 2}" rx="46" fill="none" stroke="${BLACK}" stroke-width="6"/>`,
    renderHeader(page),
    '<g role="list">',
  ];
  for (const item of page.items) {
    if (item.kind === 'ellipsis') {
      const y = item.y + 7;
      parts.push(renderInlineTextSvg(item.label, page.width / 2, y + 14, {
        fontSize: SMALL_FONT_SIZE,
        fontWeight: 700,
        fill: '#555555',
        anchor: 'middle',
      }));
    } else if (item.kind === 'time') {
      parts.push(renderTimeSvg(page, item));
    } else {
      parts.push(renderMessageSvg(item));
    }
  }
  parts.push('</g>');
  if (page.footer) {
    parts.push(renderInlineTextSvg(page.footer, page.width / 2, page.height - 24, {
      fontSize: SMALL_FONT_SIZE,
      fontWeight: 700,
      fill: '#444444',
      anchor: 'middle',
    }));
  }
  parts.push('</svg>');
  return parts.join('\n');
}

export const CLAWORLD_TRANSCRIPT_STYLE_NAME = 'claworld-comic-grid';
export const headerHeight = transcriptHeaderHeight;
export const renderIdentityRouteSvg = identityRouteSvg;
