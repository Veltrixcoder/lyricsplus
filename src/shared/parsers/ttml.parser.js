import { DOMParser } from '@xmldom/xmldom';

/**
 * Converts Apple Music's word-synced TTML format to a structured JSON object.
 * Enhanced version with corrected parsing for transliterations to handle
 * complex text node structures, including trailing text.
 * 
 * @param {string} ttml - The raw TTML content as a string.
 * @param {number} [offset=0] - An optional offset in milliseconds to apply to all timestamps.
 * @param {boolean} [separate=false] - A legacy flag to control text node handling (behavior preserved).
 * @returns {object|null} - A JSON object containing metadata and an array of lyric objects, or null on parsing failure.
 */
export function convertTTMLtoJSON(ttml, offset = 0, separate = false) {
  const KPOE = '1.7-1-ConvertTTMLtoJSON-DOMParser';

  const NS = {
    tt: 'http://www.w3.org/ns/ttml',
    itunes: 'http://music.apple.com/lyric-ttml-internal',
    ttm: 'http://www.w3.org/ns/ttml#metadata',
    xml: 'http://www.w3.org/XML/1998/namespace',
  };

  const timeToMs = (timeStr) => {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    let totalMs = 0;
    if (parts.length === 3) {
      const [h, m, s] = parts.map(p => parseFloat(p) || 0);
      totalMs = (h * 3600 + m * 60 + s) * 1000;
    } else if (parts.length === 2) {
      const [m, s] = parts.map(p => parseFloat(p) || 0);
      totalMs = (m * 60 + s) * 1000;
    } else {
      totalMs = parseFloat(parts[0]) * 1000;
    }
    return isNaN(totalMs) ? 0 : Math.round(totalMs);
  };

  const decodeHtmlEntities = (text) => {
    if (!text) return '';
    const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
    return text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => map[m] || m);
  };

  function getAttr(el, nsUri, localName, prefixedName) {
    if (!el) return null;
    try {
      if (nsUri && el.getAttributeNS) {
        const v = el.getAttributeNS(nsUri, localName);
        if (v !== null) return v;
      }
    } catch (e) {}
    if (prefixedName) {
      const v2 = el.getAttribute(prefixedName);
      if (v2 !== null) return v2;
    }
    return el.getAttribute(localName);
  }

  function collectTailText(node) {
    let txt = '';
    let sib = node.nextSibling;
    while (sib && sib.nodeType === 3) { 
      txt += sib.nodeValue || '';
      sib = sib.nextSibling;
    }
    return txt;
  }

  function isInsideBackgroundWrapper(node, paragraph) {
    let current = node.parentNode;
    while (current && current !== paragraph) {
      const roleVal = getAttr(current, NS.ttm, 'role', 'ttm:role');
      if (roleVal === 'x-bg') return true;
      current = current.parentNode;
    }
    return false;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(ttml, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length > 0) {
    console.error('Failed to parse TTML document.');
    return null;
  }

  const root = doc.documentElement;
  const timingMode = getAttr(root, NS.itunes, 'timing', 'itunes:timing') || 'Word';

  const metadata = {
    source: 'Apple Music', 
    songWriters: [], 
    title: '',
    language: getAttr(root, NS.xml, 'lang', 'xml:lang') || '',
    agents: {},
    songParts: [],
    totalDuration: getAttr(doc.getElementsByTagName('body')[0], null, 'dur', 'dur') || '',
  };

  const headEl = doc.getElementsByTagName('head')[0];
  const itunesMetaEl = headEl ? headEl.getElementsByTagName('iTunesMetadata')[0] : null;

  if (headEl) {
    // Agents
    const agentNodes = headEl.getElementsByTagName('ttm:agent');
    for (let i = 0; i < agentNodes.length; i++) {
      const a = agentNodes[i];
      const agentId = getAttr(a, NS.xml, 'id', 'xml:id');
      if (!agentId) continue;
      const type = getAttr(a, null, 'type', 'type') || 'person';
      let name = '';
      const nameNode = a.getElementsByTagName('ttm:name')[0];
      if (nameNode) name = decodeHtmlEntities(nameNode.textContent.trim());
      metadata.agents[agentId] = { type, name, alias: agentId.replace('voice', 'v') };
    }

    // Title & Songwriters
    const metaContent = itunesMetaEl || headEl.getElementsByTagName('metadata')[0];
    if (metaContent) {
      const titleEl = metaContent.getElementsByTagName('ttm:title')[0] || metaContent.getElementsByTagName('title')[0];
      if (titleEl) metadata.title = decodeHtmlEntities(titleEl.textContent.trim());

      const songwritersEl = metaContent.getElementsByTagName('songwriters')[0];
      if (songwritersEl) {
        const songwriterNodes = songwritersEl.getElementsByTagName('songwriter');
        for (let i = 0; i < songwriterNodes.length; i++) {
          const name = decodeHtmlEntities(songwriterNodes[i].textContent.trim());
          if (name) metadata.songWriters.push(name);
        }
      }
    }
  }

  const translationMap = {};
  const transliterationMap = {};

  if (itunesMetaEl) {
    // Translations
    const translationsNode = itunesMetaEl.getElementsByTagName('translations')[0];
    if (translationsNode) {
      const translationNodes = translationsNode.getElementsByTagName('translation');
      for (const transNode of translationNodes) {
        const lang = getAttr(transNode, NS.xml, 'lang', 'xml:lang');
        const textNodes = transNode.getElementsByTagName('text');
        for (const textNode of textNodes) {
          const lineId = getAttr(textNode, null, 'for', 'for');
          if (lineId) {
            translationMap[lineId] = {
              lang: lang,
              text: decodeHtmlEntities(textNode.textContent.trim())
            };
          }
        }
      }
    }

    // Transliterations
    const transliterationsNode = itunesMetaEl.getElementsByTagName('transliterations')[0];
    if (transliterationsNode) {
      const transliterationNodes = transliterationsNode.getElementsByTagName('transliteration');
      for (const translitNode of transliterationNodes) {
        const lang = getAttr(translitNode, NS.xml, 'lang', 'xml:lang');
        const textNodes = translitNode.getElementsByTagName('text');

        for (const textNode of textNodes) {
          const lineId = getAttr(textNode, null, 'for', 'for');
          if (!lineId) continue;

          // Check if it has timing spans
          const spans = Array.from(textNode.getElementsByTagName('span')).filter(
            span => getAttr(span, null, 'begin', 'begin')
          );

          if (spans.length > 0) {
            // Word Sync logic for transliteration
            const syllabus = [];
            let fullText = '';
            const processedSpans = new Set();

            for (const span of spans) {
              if (processedSpans.has(span)) continue;
              processedSpans.add(span);

              let spanText = '';
              for (const child of span.childNodes) {
                if (child.nodeType === 3) spanText += child.nodeValue || '';
              }
              spanText = decodeHtmlEntities(spanText);

              const tail = collectTailText(span);
              if (tail && !separate) spanText += decodeHtmlEntities(tail);
              
              if (spanText.trim() === '') continue;

              const begin = getAttr(span, null, 'begin', 'begin');
              const end = getAttr(span, null, 'end', 'end');

              syllabus.push({
                time: timeToMs(begin) + offset,
                duration: timeToMs(end) - timeToMs(begin),
                text: spanText,
              });
              fullText += spanText;
            }
            transliterationMap[lineId] = { lang, text: fullText.trim(), syllabus };
          } else {
            // Line Sync / Plain logic for transliteration
            transliterationMap[lineId] = {
              lang: lang,
              text: decodeHtmlEntities(textNode.textContent.trim())
            };
          }
        }
      }
    }
  }

  const lyrics = [];
  const divs = doc.getElementsByTagName('div');

  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    const songPart = getAttr(div, NS.itunes, 'song-part', 'itunes:song-part') || getAttr(div, NS.itunes, 'songPart', 'itunes:songPart') || '';
    const ps = div.getElementsByTagName('p');
    
    // Metadata: Song Parts
    let divBegin = getAttr(div, null, 'begin', 'begin');
    let divEnd = getAttr(div, null, 'end', 'end');
    
    // Fallback if div has no timing but ps do
    if ((!divBegin || !divEnd) && ps.length > 0) {
        if (!divBegin) divBegin = getAttr(ps[0], null, 'begin', 'begin');
        if (!divEnd) divEnd = getAttr(ps[ps.length - 1], null, 'end', 'end');
    }
    
    const partTime = timeToMs(divBegin) + (divBegin ? offset : 0);
    const partDur = Math.max(0, timeToMs(divEnd) - timeToMs(divBegin));

    metadata.songParts.push({
        name: songPart,
        time: partTime !== 0 ? partTime : undefined,
        duration: partDur !== 0 ? partDur : undefined,
    });

    for (let j = 0; j < ps.length; j++) {
      const p = ps[j];
      const key = getAttr(p, NS.itunes, 'key', 'itunes:key') || '';
      const singerId = getAttr(p, NS.ttm, 'agent', 'ttm:agent') || '';
      const singer = singerId.replace('voice', 'v');
      
      const pBegin = getAttr(p, null, 'begin', 'begin');
      const pEnd = getAttr(p, null, 'end', 'end');

      const currentLine = {
        time: 0,
        duration: 0,
        text: '',
        syllabus: [],
        element: { key, singer, songPartIndex: i }
      };

      // Set line timing based on P tag first
      if (pBegin && pEnd) {
          currentLine.time = timeToMs(pBegin) + offset;
          currentLine.duration = timeToMs(pEnd) - timeToMs(pBegin);
      }

      if (timingMode === 'Word') {
        const allSpansInP = Array.from(p.getElementsByTagName('span')).filter(span => getAttr(span, null, 'begin', 'begin'));
        
        if (allSpansInP.length > 0) {
            const processedSpans = new Set();
            for (const sp of allSpansInP) {
              if (processedSpans.has(sp)) continue;

              const isBg = isInsideBackgroundWrapper(sp, p);
              if (isBg) {
                Array.from(sp.getElementsByTagName('span')).forEach(nested => processedSpans.add(nested));
              }
              processedSpans.add(sp);

              const begin = getAttr(sp, null, 'begin', 'begin') || '0';
              const end = getAttr(sp, null, 'end', 'end') || '0';

              let spanText = '';
              for (const child of sp.childNodes) {
                if (child.nodeType === 3) spanText += child.nodeValue || '';
              }
              spanText = decodeHtmlEntities(spanText);

              const tail = collectTailText(sp);
              if (tail && !separate) spanText += decodeHtmlEntities(tail);

              if (spanText.trim() === '' && (!tail || !tail.includes(' '))) continue;

              const syllabusEntry = {
                time: timeToMs(begin) + offset,
                duration: timeToMs(end) - timeToMs(begin),
                text: spanText
              };
              if (isBg) syllabusEntry.isBackground = true;

              currentLine.syllabus.push(syllabusEntry);
              currentLine.text += spanText;
            }
        } else {
             // Fallback for Word mode if no spans found (treat as line)
            currentLine.text = decodeHtmlEntities(p.textContent.trim());
        }
      } else {
        // Line Sync or None
        let lineText = '';
        const extractText = (node) => {
            let t = '';
            for (const child of node.childNodes) {
                if (child.nodeType === 3) t += child.nodeValue || '';
                else if (child.nodeType === 1) t += extractText(child);
            }
            return t;
        };
        lineText = extractText(p);
        currentLine.text = decodeHtmlEntities(lineText.trim());
        
        // If Plain text (None), ensure time is 0 if not present
        if (timingMode === 'None' || (!pBegin && !pEnd)) {
            currentLine.time = undefined;
            currentLine.duration = undefined;
        }
      }

      // Add if valid
      if (currentLine.text || currentLine.syllabus.length > 0) {
        if (key && translationMap[key]) currentLine.translation = translationMap[key];
        if (key && transliterationMap[key]) currentLine.transliteration = transliterationMap[key];
        lyrics.push(currentLine);
      }
    }
  }

  return {
    KpoeTools: KPOE,
    type: timingMode,
    metadata,
    lyrics,
  };
}

/**
 * JSON to Apple TTML Converter
 * Enhanced version that properly handles Apple's TTML specifications
 * 
 * @param {Object} jsonLyrics - The JSON lyrics object
 * @returns {String} - The TTML formatted XML string
 */
export function convertJsonToTTML(jsonLyrics) {
  const formatTime = (ms) => {
    if (isNaN(ms) || ms < 0) ms = 0;
    const totalSec = ms / 1000;
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const msPart = Math.round((totalSec % 1) * 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${msPart.toString().padStart(3, '0')}`;
  };

  const escapeHtml = (text) => {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  };

  const extractTextAndSpace = (fullText) => {
    if (!fullText) return { pre: '', text: '', post: '' };
    const match = fullText.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { pre: match[1] || '', text: match[2] || '', post: match[3] || '' };
  };

  const metadata = jsonLyrics.metadata || {};
  const songPartsArray = metadata.songParts || [];
  const isNewFormat = jsonLyrics.lyrics?.some(l => l.element?.songPartIndex != null);

  const agents = {};
  if (metadata.agents) {
    for (const [key, val] of Object.entries(metadata.agents)) agents[key] = { ...val };
  }
  if (jsonLyrics.lyrics) {
    const usedSingers = new Set(jsonLyrics.lyrics.map(l => l.element?.singer).filter(Boolean));
    for (const alias of usedSingers) {
      const existingId = Object.keys(agents).find(id => agents[id].alias === alias || id === alias);
      if (!existingId) agents[alias] = { type: 'person', name: '', alias };
    }
  }

  const findAgentId = (alias) => {
    if (!alias) return null;
    return Object.keys(agents).find(key => agents[key].alias === alias || key === alias) || alias;
  };

  const resolveSongPart = (element) => {
    if (element?.songPart) {
      const p = element.songPart;
      return p.charAt(0).toUpperCase() + p.slice(1);
    }
    if (element?.songPartIndex != null && songPartsArray[element.songPartIndex]) {
      const p = songPartsArray[element.songPartIndex].name;
      return p.charAt(0).toUpperCase() + p.slice(1);
    }
    return '';
  };

  const timingMode = jsonLyrics.type || "Word";
  const lang = metadata.language || "en";

  let ttml = '<?xml version="1.0" encoding="UTF-8"?>';
  ttml += `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:xml="http://www.w3.org/XML/1998/namespace" itunes:timing="${timingMode}" xml:lang="${lang}">`;
  ttml += '<head><metadata>';
  if (metadata.title) ttml += `<ttm:title>${escapeHtml(metadata.title)}</ttm:title>`;

  for (const [id, agent] of Object.entries(agents)) {
    const type = agent.type || 'person';
    if (agent.name) {
      ttml += `<ttm:agent type="${escapeHtml(type)}" xml:id="${escapeHtml(id)}"><ttm:name>${escapeHtml(agent.name)}</ttm:name></ttm:agent>`;
    } else {
      ttml += `<ttm:agent type="${escapeHtml(type)}" xml:id="${escapeHtml(id)}"/>`;
    }
  }

  const leadingSilence = metadata.leadingSilence || "0.000";
  ttml += `<iTunesMetadata leadingSilence="${leadingSilence}">`;
  if (Array.isArray(metadata.songWriters) && metadata.songWriters.length > 0) {
    ttml += '<songwriters>';
    metadata.songWriters.forEach(sw => { ttml += `<songwriter>${escapeHtml(sw)}</songwriter>`; });
    ttml += '</songwriters>';
  }
  ttml += '</iTunesMetadata></metadata></head>';

  let totalDur = metadata.totalDuration;
  if (!totalDur && jsonLyrics.lyrics?.length > 0) {
    const lastLine = jsonLyrics.lyrics[jsonLyrics.lyrics.length - 1];
    totalDur = formatTime(lastLine.time + lastLine.duration);
  } else if (!totalDur) {
    totalDur = "00:00.000";
  }

  ttml += `<body dur="${totalDur}">`;

  if (jsonLyrics.lyrics?.length > 0) {
    let currentLines = [];
    let currentSongPart = null;
    let currentSongPartIndex = null;

    const flushDiv = () => {
      if (currentLines.length === 0) return;
      const divStart = currentLines[0].time;
      const lastLine = currentLines[currentLines.length - 1];
      const divEnd = lastLine.time + lastLine.duration;

      ttml += `<div begin="${formatTime(divStart)}" end="${formatTime(divEnd)}"`;
      if (currentSongPart) ttml += ` itunes:song-part="${escapeHtml(currentSongPart)}"`;
      ttml += '>';

      for (const line of currentLines) {
        const agentId = findAgentId(line.element?.singer);
        const key = line.element?.key;
        ttml += `<p begin="${formatTime(line.time)}" end="${formatTime(line.time + line.duration)}"`;
        if (key) ttml += ` itunes:key="${key}"`;
        if (agentId) ttml += ` ttm:agent="${agentId}"`;
        ttml += '>';

        if (timingMode === 'Word' && line.syllabus?.length > 0) {
          let bgBuffer = [];
          const flushBg = () => {
            if (bgBuffer.length === 0) return;
            ttml += '<span ttm:role="x-bg">';
            bgBuffer.forEach(s => {
              const { pre, text, post } = extractTextAndSpace(s.text);
              ttml += `${pre}<span begin="${formatTime(s.time)}" end="${formatTime(s.time + s.duration)}">${escapeHtml(text)}</span>${post}`;
            });
            ttml += '</span>';
            bgBuffer = [];
          };
          for (const syl of line.syllabus) {
            if (syl.isBackground) {
              bgBuffer.push(syl);
            } else {
              flushBg();
              const { pre, text, post } = extractTextAndSpace(syl.text);
              ttml += `${pre}<span begin="${formatTime(syl.time)}" end="${formatTime(syl.time + syl.duration)}">${escapeHtml(text)}</span>${post}`;
            }
          }
          flushBg();
        } else {
          ttml += escapeHtml(line.text);
        }
        ttml += '</p>';
      }
      ttml += '</div>';
    };

    for (const line of jsonLyrics.lyrics) {
      const songPart = resolveSongPart(line.element);
      const songPartIndex = line.element?.songPartIndex ?? null;

      if (currentSongPart === null) {
        currentSongPart = songPart;
        currentSongPartIndex = songPartIndex;
      }

      const shouldSplit = isNewFormat
        ? songPartIndex !== currentSongPartIndex
        : songPart !== currentSongPart;

      if (shouldSplit && currentLines.length > 0) {
        flushDiv();
        currentLines = [];
        currentSongPart = songPart;
        currentSongPartIndex = songPartIndex;
      }

      currentLines.push(line);
    }
    flushDiv();
  }

  ttml += '</body></tt>';
  return ttml;
}
