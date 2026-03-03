import React, { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { 
  Youtube, 
  FileText, 
  LayoutDashboard, 
  Download, 
  Copy, 
  Check, 
  AlertCircle, 
  Loader2, 
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Trash2,
  Play,
  Settings,
  Code,
  X,
  RotateCcw,
  Archive,
  Plus,
  Settings2,
  MonitorPlay
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { VideoResult, TranscriptSegment, ExportFormat } from './types';
import { generateSummary } from './services/gemini';

const DEFAULT_SUMMARY_STRUCTURE = `1. TL;DR (5-8 bullets, punchy)
2. Detailed Outline (H2/H3 headings)
3. Key Concepts & Definitions (term → definition)
4. Step-by-step / Process (if applicable)
5. Examples Mentioned (bulleted)
6. Tools / Frameworks / Names mentioned (bulleted)
7. "If I only remember 10 things" (top takeaways)
8. Action Items / Next Steps (if applicable)
9. Open Questions / Uncertainties
10. Time Index (map major sections to approximate timestamps if available in transcript)
11. Knowledge Graph Lite (list entities like people/tools/concepts and their relationships)`;

const DEFAULT_SYSTEM_INSTRUCTION = `You are an expert content analyst. Your task is to provide a high-quality, structured summary of a YouTube video transcript.
Follow these rules strictly:
1. Use the transcript as the ONLY source of truth.
2. Do NOT hallucinate. If information is missing, state it is unavailable.
3. Be specific: preserve names, numbers, steps, and constraints.
4. Output in Markdown format with the specific sections requested.
5. Include a 'Knowledge Graph Lite' section listing entities and relationships.`;

// --- Extension Code Templates ---
const EXTENSION_FILES = {
  'manifest.json': `{
  "manifest_version": 3,
  "name": "TubeScript AI Helper",
  "version": "1.3",
  "description": "Extracts transcripts from YouTube for TubeScript AI Dashboard",
  "permissions": ["tabs", "scripting", "activeTab"],
  "host_permissions": ["https://www.youtube.com/*"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/watch*"],
      "js": ["content_script.js"],
      "all_frames": true
    },
    {
      "matches": ["*://*.run.app/*", "http://localhost:*/*"],
      "js": ["bridge.js"],
      "all_frames": true
    }
  ]
}`,
  'background.js': `chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("TubeScript AI: Background received", request.type);
  
  if (request.type === 'TRANSCRIPT_DATA') {
    // Broadcast to all tabs, but ignore errors for tabs without listeners
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, request, () => {
          // Accessing lastError suppresses the "Receiving end does not exist" console error
          const err = chrome.runtime.lastError;
        });
      });
    });
    
    // Close the YouTube tab
    if (sender.tab) {
      setTimeout(() => {
        chrome.tabs.remove(sender.tab.id);
      }, 1500);
    }
  }
  return true;
});`,
  'content_script.js': `(async function() {
  console.log("TubeScript AI: Content script loaded");

  async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function extractTranscript() {
    try {
      // Wait for metadata
      for (let i = 0; i < 20; i++) {
        if (document.querySelector('ytd-watch-metadata') || document.querySelector('h1.ytd-video-primary-info-renderer')) break;
        await wait(500);
      }

      // Find transcript button
      let btn = document.querySelector('button[aria-label="Show transcript"]') || 
                Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Show transcript'));

      if (!btn) {
        const more = document.querySelector('#action-buttons #button-shape button[aria-label="More actions"]') ||
                     document.querySelector('ytd-watch-metadata #button-shape button[aria-label="More actions"]') ||
                     document.querySelector('ytd-video-primary-info-renderer #button-shape button');
        if (more) {
          more.click();
          await wait(800);
          btn = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer')).find(el => el.textContent.includes('Show transcript'));
        }
      }

      if (btn) btn.click();
      await wait(2000);

      // Wait for segments
      let segments = [];
      for (let i = 0; i < 15; i++) {
        segments = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));
        if (segments.length > 0) break;
        await wait(1000);
      }

      if (segments.length === 0) throw new Error("Transcript segments not found. Is it disabled?");

      const data = segments.map(el => ({
        startTime: el.querySelector('.segment-timestamp')?.textContent?.trim() || "",
        text: el.querySelector('.segment-text')?.textContent?.trim() || ""
      }));

      const title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim() || 
                    document.querySelector('ytd-watch-metadata h1')?.textContent?.trim() ||
                    document.title;
      
      const channel = document.querySelector('#upload-info #channel-name a')?.textContent?.trim() || 
                      document.querySelector('ytd-video-owner-renderer #channel-name a')?.textContent?.trim() || "";

      return { success: true, data: { transcript: data, metadata: { title, channel } } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (window.location.search.includes('tubescript=true')) {
     await wait(2000); // Initial settle
     const result = await extractTranscript();
     chrome.runtime.sendMessage({ type: 'TRANSCRIPT_DATA', result, url: window.location.href });
  }
})();`,
  'bridge.js': `console.log("TubeScript AI: Bridge active");
window.addEventListener('message', (e) => {
  if (e.data.type === 'CHECK_EXTENSION') window.postMessage({ type: 'EXTENSION_PONG' }, '*');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRANSCRIPT_DATA') {
    window.postMessage({ type: 'FROM_EXTENSION_TRANSCRIPT', data: msg }, '*');
  }
});`
};

export default function App() {
  const [urls, setUrls] = useState('');
  const [results, setResults] = useState<VideoResult[]>([]);
  const [isExtensionInstalled, setIsExtensionInstalled] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'extension'>('dashboard');
  const [viewerTab, setViewerTab] = useState<'video' | 'transcript' | 'summary'>('video');
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [manualTranscript, setManualTranscript] = useState('');
  const [isManualInputOpen, setIsManualInputOpen] = useState(false);
  const [autoFetch, setAutoFetch] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isStructureModalOpen, setIsStructureModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [summaryStructure, setSummaryStructure] = useState(DEFAULT_SUMMARY_STRUCTURE);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  
  const autoFetchRef = useRef(autoFetch);
  const isExtensionInstalledRef = useRef(isExtensionInstalled);
  const isFetchingRef = useRef(false);
  const timeoutsRef = useRef<Record<string, any>>({});
  const selectedIdsRef = useRef(selectedIds);
  const activeWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    autoFetchRef.current = autoFetch;
  }, [autoFetch]);

  useEffect(() => {
    isExtensionInstalledRef.current = isExtensionInstalled;
  }, [isExtensionInstalled]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  // Check for extension
  useEffect(() => {
    const checkExt = () => {
      window.postMessage({ type: 'CHECK_EXTENSION' }, '*');
    };
    
    const handleMessage = (e: MessageEvent) => {
      if (e.data.type === 'EXTENSION_PONG') {
        setIsExtensionInstalled(true);
      }
      if (e.data.type === 'FROM_EXTENSION_TRANSCRIPT') {
        handleExtensionData(e.data.data);
      }
    };

    window.addEventListener('message', handleMessage);
    const interval = setInterval(checkExt, 2000);
    checkExt();

    return () => {
      window.removeEventListener('message', handleMessage);
      clearInterval(interval);
    };
  }, []); // Listener stays attached, uses refs for state

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ message, type });
  };

  const handleExtensionData = (data: any) => {
    const { url, result } = data;
    
    setResults(prev => {
      // Check if this URL is actually being fetched right now in our state
      const videoEntry = prev.find(r => r.url === url && r.status === 'fetching');
      if (!videoEntry) return prev; // Ignore messages for videos not currently being fetched

      // Clear timeout
      if (timeoutsRef.current[videoEntry.id]) {
        clearTimeout(timeoutsRef.current[videoEntry.id]);
        delete timeoutsRef.current[videoEntry.id];
      }

      // Close window
      if (activeWindowRef.current) {
        try {
          activeWindowRef.current.close();
        } catch (e) {
          console.error("Failed to close window:", e);
        }
        activeWindowRef.current = null;
      }

      const updated = prev.map(res => {
        if (res.url === url && res.status === 'fetching') {
          if (result.success) {
            return {
              ...res,
              status: 'idle' as const,
              transcript: result.data.transcript,
              rawTranscript: result.data.transcript.map((s: any) => s.text).join(' '),
              metadata: result.data.metadata
            };
          } else {
            // Close window on error too
            if (activeWindowRef.current) {
              try { activeWindowRef.current.close(); } catch (e) {}
              activeWindowRef.current = null;
            }
            return { ...res, status: 'error' as const, error: result.error };
          }
        }
        return res;
      });

      // Release the lock
      isFetchingRef.current = false;

      // Auto-fetch next logic (either global autoFetch or part of a selection)
      if (autoFetchRef.current || selectedIdsRef.current.size > 0) {
        const currentIndex = updated.findIndex(r => r.url === url);
        if (currentIndex !== -1) {
          const nextVideo = updated.slice(currentIndex + 1).find(r => {
            const isIdle = r.status === 'idle' && !r.transcript;
            // If we have a selection, only auto-fetch if the next one is in selection
            if (selectedIdsRef.current.size > 0) {
              return isIdle && selectedIdsRef.current.has(r.id);
            }
            // Otherwise follow global autoFetch
            return isIdle && autoFetchRef.current;
          });

          if (nextVideo) {
            // 5 second pause as requested by user
            console.log(`TubeScript AI: Waiting 5s before fetching next: ${nextVideo.url}`);
            setTimeout(() => {
              // Re-check lock and conditions before proceeding
              const stillInSelection = selectedIdsRef.current.size === 0 || selectedIdsRef.current.has(nextVideo.id);
              if ((autoFetchRef.current || selectedIdsRef.current.size > 0) && stillInSelection) {
                fetchTranscript(nextVideo);
              }
            }, 5000);
          }
        }
      }

      return updated;
    });
  };

  const handleManualSubmit = () => {
    if (!selectedVideoId || !manualTranscript.trim()) return;
    
    setResults(prev => prev.map(r => {
      if (r.id === selectedVideoId) {
        return {
          ...r,
          status: 'idle' as const,
          rawTranscript: manualTranscript,
          transcript: [{ startTime: "0:00", text: manualTranscript }], // Mock segment
          metadata: r.metadata || { title: "Manual Input", channel: "User Provided" }
        };
      }
      return r;
    }));
    setManualTranscript('');
    setIsManualInputOpen(false);
  };

  const addUrls = () => {
    const urlList = urls.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
    const newResults: VideoResult[] = urlList.map(url => ({
      id: Math.random().toString(36).substr(2, 9),
      url,
      status: 'idle' as const
    }));
    setResults(prev => [...prev, ...newResults]);
    setUrls('');
  };

  const fetchTranscript = async (video: VideoResult) => {
    if (!isExtensionInstalledRef.current) {
      showNotification("Please install the TubeScript AI Helper extension first.", 'error');
      return;
    }

    if (isFetchingRef.current) {
      console.log("TubeScript AI: Already fetching a video, skipping...");
      return;
    }

    isFetchingRef.current = true;
    setResults(prev => prev.map(r => r.id === video.id ? { ...r, status: 'fetching' as const, error: undefined } : r));
    
    // Auto-timeout after 60 seconds
    const timeoutId = setTimeout(() => {
      setResults(prev => {
        const current = prev.find(r => r.id === video.id);
        if (current && current.status === 'fetching') {
          console.log(`TubeScript AI: Fetch timed out for ${video.url}`);
          isFetchingRef.current = false;
          delete timeoutsRef.current[video.id];
          
          if (activeWindowRef.current) {
            try {
              activeWindowRef.current.close();
            } catch (e) {}
            activeWindowRef.current = null;
          }
          
          const updated = prev.map(r => r.id === video.id ? { ...r, status: 'error' as const, error: 'Fetch timed out' } : r);
          
          // Trigger next if auto-fetch is on
          if (autoFetchRef.current || selectedIdsRef.current.size > 0) {
             const currentIndex = updated.findIndex(r => r.id === video.id);
             const nextVideo = updated.slice(currentIndex + 1).find(r => {
               const isIdle = r.status === 'idle' && !r.transcript;
               if (selectedIdsRef.current.size > 0) {
                 return isIdle && selectedIdsRef.current.has(r.id);
               }
               return isIdle && autoFetchRef.current;
             });
             if (nextVideo) {
               console.log(`TubeScript AI: Auto-skipping to next video after timeout...`);
               setTimeout(() => fetchTranscript(nextVideo), 5000);
             }
          }
          return updated;
        }
        return prev;
      });
    }, 60000);

    timeoutsRef.current[video.id] = timeoutId;

    // Open YouTube in a new tab with a flag
    const youtubeUrl = new URL(video.url);
    youtubeUrl.searchParams.set('tubescript', 'true');
    const win = window.open(youtubeUrl.toString(), '_blank');
    activeWindowRef.current = win;
  };

  const cancelCurrentFetch = () => {
    const fetchingVideo = results.find(r => r.status === 'fetching');
    if (fetchingVideo) {
      if (timeoutsRef.current[fetchingVideo.id]) {
        clearTimeout(timeoutsRef.current[fetchingVideo.id]);
        delete timeoutsRef.current[fetchingVideo.id];
      }
      if (activeWindowRef.current) {
        try {
          activeWindowRef.current.close();
        } catch (e) {}
        activeWindowRef.current = null;
      }
      setResults(prev => prev.map(r => r.id === fetchingVideo.id ? { ...r, status: 'error' as const, error: 'Manually cancelled' } : r));
      isFetchingRef.current = false;
      
      // If auto-fetch is on, move to next
      if (autoFetchRef.current || selectedIdsRef.current.size > 0) {
        const currentIndex = results.findIndex(r => r.id === fetchingVideo.id);
        const nextVideo = results.slice(currentIndex + 1).find(r => {
          const isIdle = r.status === 'idle' && !r.transcript;
          if (selectedIdsRef.current.size > 0) {
            return isIdle && selectedIdsRef.current.has(r.id);
          }
          return isIdle && autoFetchRef.current;
        });
        if (nextVideo) {
          setTimeout(() => fetchTranscript(nextVideo), 5000);
        }
      }
    } else {
      // Emergency reset if ref is stuck but no video shows as fetching
      isFetchingRef.current = false;
    }
  };

  const summarizeVideo = async (video: VideoResult) => {
    if (!video.rawTranscript) return;

    setResults(prev => prev.map(r => r.id === video.id ? { ...r, status: 'summarizing' as const } : r));
    setViewerTab('summary');

    try {
      const summary = await generateSummary(video.rawTranscript, summaryStructure, (partial) => {
        setResults(prev => prev.map(r => r.id === video.id ? { ...r, summary: partial } : r));
      });
      setResults(prev => prev.map(r => r.id === video.id ? { ...r, status: 'completed' as const, summary } : r));
    } catch (err: any) {
      setResults(prev => prev.map(r => r.id === video.id ? { ...r, status: 'error' as const, error: err.message } : r));
    }
  };

  const fetchAndSummarize = async (video: VideoResult) => {
    await fetchTranscript(video);
    // Note: In a real app, we'd wait for the transcript to arrive before summarizing.
    // Since we can't easily await the extension message here, we'll just trigger fetch.
    // The user will see the transcript arrive and can then click summarize, or we could
    // add an effect that auto-summarizes when transcript arrives if a flag is set.
  };

  const processAll = async () => {
    const firstIdle = results.find(r => {
      const isIdle = r.status === 'idle' && !r.transcript;
      if (selectedIds.size > 0) {
        return isIdle && selectedIds.has(r.id);
      }
      return isIdle;
    });
    if (firstIdle) {
      fetchTranscript(firstIdle);
    }
  };

  const bulkDelete = () => {
    if (selectedIds.size === 0) return;
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = () => {
    setResults(prev => prev.filter(r => !selectedIds.has(r.id)));
    setSelectedIds(new Set());
    setIsDeleteModalOpen(false);
    showNotification(`Deleted ${selectedIds.size} videos`, 'success');
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === results.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(results.map(r => r.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const bulkDownload = async (type: 'transcript' | 'summary') => {
    const zip = new JSZip();
    const selectedVideos = results.filter(r => selectedIds.has(r.id));
    
    let addedCount = 0;
    selectedVideos.forEach(video => {
      const title = (video.metadata?.title || video.id).replace(/[/\\?%*:|"<>]/g, '-');
      if (type === 'transcript' && video.rawTranscript) {
        const content = video.transcript 
          ? video.transcript.map(s => `[${s.startTime}] ${s.text}`).join('\n') 
          : video.rawTranscript;
        zip.file(`${title}-transcript.txt`, content);
        addedCount++;
      } else if (type === 'summary' && video.summary) {
        const content = `# ${video.metadata?.title || 'Video Summary'}\n\nURL: ${video.url}\n\n${video.summary}`;
        zip.file(`${title}-summary.md`, content);
        addedCount++;
      }
    });

    if (addedCount === 0) {
      showNotification(`No ${type}s available to download for selected videos.`, 'error');
      return;
    }

    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tubescript-bulk-${type}s.zip`;
    a.click();
  };

  const exportResult = (video: VideoResult, format: ExportFormat | 'transcript') => {
    let content = '';
    const safeTitle = (video.metadata?.title || 'video')
      .replace(/[/\\?%*:|"<>]/g, '-') // Sanitize for filename
      .substring(0, 100);
    
    let filename = safeTitle;

    if (format === 'markdown') {
      content = `# ${video.metadata?.title || 'Video Summary'}\n\nURL: ${video.url}\n\n${video.summary || 'No summary available.'}`;
      filename += '-summary.md';
    } else if (format === 'transcript') {
      content = video.transcript ? video.transcript.map(s => `[${s.startTime}] ${s.text}`).join('\n') : (video.rawTranscript || '');
      filename += '-transcript.txt';
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };

  const selectedVideo = results.find(r => r.id === selectedVideoId);

  const getYoutubeEmbedUrl = (url: string) => {
    try {
      const videoId = new URL(url).searchParams.get('v');
      return `https://www.youtube.com/embed/${videoId}`;
    } catch (e) {
      return '';
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[#FDFCFB] text-[#1A1A1A] font-sans overflow-hidden">
      {/* Header */}
      <header className="border-b border-[#E5E5E5] bg-white z-10 shrink-0">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center">
                <Youtube className="text-white w-6 h-6" />
              </div>
              <h1 className="text-xl font-bold tracking-tight">TubeScript AI</h1>
            </div>

            <div className="flex items-center gap-2">
              <button 
                onClick={() => setIsAddModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-xl text-sm font-medium hover:bg-zinc-800 transition-all"
              >
                <Plus size={16} /> Add Videos
              </button>
              <button 
                onClick={() => setIsStructureModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-[#F5F5F5] text-black rounded-xl text-sm font-medium hover:bg-[#EEEEEE] transition-all"
              >
                <Settings2 size={16} /> Summary Structure
              </button>
            </div>
          </div>
          
          <nav className="flex items-center gap-1 bg-[#F5F5F5] p-1 rounded-xl">
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'dashboard' ? 'bg-white shadow-sm' : 'text-[#666] hover:text-black'}`}
            >
              Dashboard
            </button>
            <button 
              onClick={() => setActiveTab('extension')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'extension' ? 'bg-white shadow-sm' : 'text-[#666] hover:text-black'}`}
            >
              Extension Setup
            </button>
          </nav>

          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${isExtensionInstalled ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
              {isExtensionInstalled ? <Check size={14} /> : <AlertCircle size={14} />}
              {isExtensionInstalled ? 'Extension Active' : 'Extension Missing'}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden max-w-7xl mx-auto w-full px-6 py-6">
        {activeTab === 'dashboard' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-full">
            {/* Left Column: Queue */}
            <div className="lg:col-span-4 flex flex-col h-full overflow-hidden">
              <section className="bg-white border border-[#E5E5E5] rounded-2xl overflow-hidden shadow-sm flex flex-col h-full">
                <div className="p-4 border-b border-[#F5F5F5] space-y-3 shrink-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input 
                        type="checkbox"
                        checked={results.length > 0 && selectedIds.size === results.length}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded border-gray-300 text-black focus:ring-black cursor-pointer"
                      />
                      <h2 className="text-sm font-semibold uppercase tracking-wider text-[#666]">
                        {selectedIds.size > 0 ? `${selectedIds.size}/${results.length} Selected` : `Queue (${results.length})`}
                      </h2>
                    </div>
                    {selectedIds.size > 0 && (
                      <button 
                        onClick={bulkDelete}
                        className="text-[#999] hover:text-red-500 transition-colors"
                        title="Delete Selected"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>

                  {selectedIds.size > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {results.some(r => selectedIds.has(r.id) && !r.transcript && (r.status === 'idle' || r.status === 'error')) && (
                        <button 
                          onClick={processAll}
                          className="text-[10px] font-bold uppercase tracking-tight bg-black text-white px-2 py-1 rounded hover:bg-zinc-800 transition-colors flex items-center gap-1"
                        >
                          <Download size={12} /> Fetch [{results.filter(r => selectedIds.has(r.id) && !r.transcript && (r.status === 'idle' || r.status === 'error')).length}]
                        </button>
                      )}
                      {results.some(r => selectedIds.has(r.id) && r.transcript) && (
                        <button 
                          onClick={() => bulkDownload('transcript')}
                          className="text-[10px] font-bold uppercase tracking-tight bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 transition-colors flex items-center gap-1"
                        >
                          <Archive size={12} /> Zip Transcripts [{results.filter(r => selectedIds.has(r.id) && r.transcript).length}]
                        </button>
                      )}
                      {results.some(r => selectedIds.has(r.id) && r.summary) && (
                        <button 
                          onClick={() => bulkDownload('summary')}
                          className="text-[10px] font-bold uppercase tracking-tight bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700 transition-colors flex items-center gap-1"
                        >
                          <Archive size={12} /> Zip Summaries [{results.filter(r => selectedIds.has(r.id) && r.summary).length}]
                        </button>
                      )}
                    </div>
                  )}
                  
                  {results.some(r => r.status === 'fetching') && (
                    <button 
                      onClick={cancelCurrentFetch}
                      className="w-full text-[10px] font-bold uppercase tracking-tight bg-red-50 text-red-600 py-1.5 rounded hover:bg-red-100 transition-colors flex items-center justify-center gap-2"
                    >
                      <X size={14} /> Stop Current Fetch
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {results.length === 0 ? (
                    <div className="p-8 text-center text-[#999] text-sm italic">
                      No videos in queue. Click "Add Videos" to start.
                    </div>
                  ) : (
                    results.map((video) => (
                      <div 
                        key={video.id}
                        onClick={() => setSelectedVideoId(video.id)}
                        className={`p-4 border-b border-[#F5F5F5] cursor-pointer transition-colors hover:bg-[#F9F9F9] flex items-start gap-3 ${selectedVideoId === video.id ? 'bg-[#F5F5F5]' : ''}`}
                      >
                        <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                          <input 
                            type="checkbox"
                            checked={selectedIds.has(video.id)}
                            onChange={() => toggleSelect(video.id)}
                            className="w-4 h-4 rounded border-gray-300 text-black focus:ring-black cursor-pointer"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate mb-1">
                            {video.metadata?.title || video.url}
                          </p>
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-bold uppercase tracking-tight ${
                              video.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                              video.status === 'error' ? 'bg-red-100 text-red-700' :
                              video.status === 'fetching' || video.status === 'summarizing' ? 'bg-blue-100 text-blue-700' :
                              'bg-gray-100 text-gray-600'
                            }`}>
                              {video.status}
                            </span>
                            {video.transcript && (
                              <span className="text-[10px] text-[#999] font-medium">
                                {video.transcript.length} segments
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          {video.status === 'fetching' && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); cancelCurrentFetch(); }}
                              className="p-1.5 hover:bg-red-50 rounded-lg text-red-500 transition-colors"
                              title="Cancel Fetch"
                            >
                              <X size={14} />
                            </button>
                          )}
                          {!video.transcript && (video.status === 'idle' || video.status === 'error') && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); fetchTranscript(video); }}
                              className="p-1.5 hover:bg-white rounded-lg text-[#666] transition-colors"
                              title={video.status === 'error' ? "Retry Fetch" : "Fetch Transcript"}
                            >
                              {video.status === 'error' ? <RotateCcw size={14} /> : <Download size={14} />}
                            </button>
                          )}
                          {video.transcript && !video.summary && (video.status === 'idle' || video.status === 'error') && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); summarizeVideo(video); }}
                              className="p-1.5 hover:bg-white rounded-lg text-[#666] transition-colors"
                              title="Summarize"
                            >
                              <FileText size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                </section>
              </div>

            <div className="lg:col-span-8 h-full overflow-hidden">
              {selectedVideo ? (
                <div className="bg-white border border-[#E5E5E5] rounded-2xl shadow-sm h-full flex flex-col overflow-hidden">
                  <div className="p-6 border-b border-[#F5F5F5] flex items-center justify-between shrink-0">
                    <div>
                      <h2 className="text-xl font-bold mb-1 truncate max-w-md">{selectedVideo.metadata?.title || 'Video Details'}</h2>
                      <p className="text-sm text-[#666] flex items-center gap-2">
                        {selectedVideo.metadata?.channel && <span>{selectedVideo.metadata.channel}</span>}
                        <span className="w-1 h-1 bg-[#DDD] rounded-full" />
                        <a href={selectedVideo.url} target="_blank" rel="noreferrer" className="hover:text-black flex items-center gap-1">
                          View on YouTube <ExternalLink size={12} />
                        </a>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!selectedVideo.transcript ? (
                        <button 
                          onClick={() => fetchTranscript(selectedVideo)}
                          disabled={selectedVideo.status === 'fetching'}
                          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
                            selectedVideo.status === 'fetching' 
                              ? 'bg-[#F5F5F5] text-[#999] cursor-not-allowed' 
                              : 'bg-black text-white hover:bg-zinc-800 shadow-sm'
                          }`}
                        >
                          {selectedVideo.status === 'fetching' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                          {selectedVideo.status === 'fetching' ? 'Fetching...' : 'Transcript'}
                        </button>
                      ) : (
                        <>
                          <button 
                            onClick={() => exportResult(selectedVideo, 'transcript')}
                            className="px-4 py-2 bg-[#F5F5F5] hover:bg-[#EEE] rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                          >
                            <Download size={16} /> Transcript
                          </button>
                          
                          {!selectedVideo.summary ? (
                            <button 
                              onClick={() => summarizeVideo(selectedVideo)}
                              disabled={selectedVideo.status === 'summarizing'}
                              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
                                selectedVideo.status === 'summarizing' 
                                  ? 'bg-[#F5F5F5] text-[#999] cursor-not-allowed' 
                                  : 'bg-black text-white hover:bg-zinc-800 shadow-sm'
                              }`}
                            >
                              {selectedVideo.status === 'summarizing' ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                              {selectedVideo.status === 'summarizing' ? 'Summarizing...' : 'Summary'}
                            </button>
                          ) : (
                            <button 
                              onClick={() => exportResult(selectedVideo, 'markdown')}
                              className="px-4 py-2 bg-[#F5F5F5] hover:bg-[#EEE] rounded-xl text-sm font-medium transition-colors flex items-center gap-2"
                            >
                              <Download size={16} /> Summary
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="flex border-b border-[#F5F5F5] px-6 shrink-0">
                      {(['video', 'transcript', 'summary'] as const).map((tab) => (
                        <button
                          key={tab}
                          onClick={() => setViewerTab(tab)}
                          className={`px-6 py-4 text-sm font-medium relative capitalize transition-colors ${viewerTab === tab ? 'text-black' : 'text-[#999] hover:text-[#666]'}`}
                        >
                          {tab}
                          {viewerTab === tab && (
                            <motion.div 
                              layoutId="activeTab"
                              className="absolute bottom-0 left-0 right-0 h-0.5 bg-black" 
                            />
                          )}
                        </button>
                      ))}
                    </div>

                    <div className="flex-1 overflow-y-auto p-6">
                      {viewerTab === 'video' && (
                        <div className="space-y-6">
                          <div className="aspect-video bg-black rounded-2xl overflow-hidden shadow-lg">
                            <iframe 
                              src={getYoutubeEmbedUrl(selectedVideo.url)}
                              className="w-full h-full"
                              allowFullScreen
                              title="YouTube Video"
                            />
                          </div>
                        </div>
                      )}

                      {viewerTab === 'transcript' && (
                        <div className="space-y-4">
                          {!selectedVideo.transcript ? (
                            <div className="flex flex-col items-center justify-center py-20 text-[#999] space-y-4">
                              <Download size={48} className="opacity-20" />
                              <p>Transcript not fetched yet.</p>
                              <button 
                                onClick={() => fetchTranscript(selectedVideo)}
                                className="px-6 py-2 bg-black text-white rounded-xl text-sm font-medium"
                              >
                                Fetch Now
                              </button>
                            </div>
                          ) : (
                            selectedVideo.transcript.map((s, i) => (
                              <div key={i} className="flex gap-4 group">
                                <span className="text-[10px] font-mono text-[#999] pt-1 w-12 shrink-0">{s.startTime}</span>
                                <p className="text-sm leading-relaxed text-[#444] group-hover:text-black transition-colors">{s.text}</p>
                              </div>
                            ))
                          )}
                        </div>
                      )}

                      {viewerTab === 'summary' && (
                        <div className="prose prose-sm max-w-none">
                          {selectedVideo.status === 'summarizing' && !selectedVideo.summary && (
                            <div className="flex flex-col items-center justify-center py-20 text-[#999] space-y-4">
                              <Loader2 size={48} className="animate-spin opacity-20" />
                              <p>Generating summary with AI...</p>
                            </div>
                          )}
                          {!selectedVideo.summary && selectedVideo.status !== 'summarizing' && (
                            <div className="flex flex-col items-center justify-center py-20 text-[#999] space-y-4">
                              <FileText size={48} className="opacity-20" />
                              <p>No summary generated yet.</p>
                              <button 
                                onClick={() => summarizeVideo(selectedVideo)}
                                className="px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium"
                              >
                                Generate Summary
                              </button>
                            </div>
                          )}
                          {selectedVideo.summary && (
                            <div className="markdown-body">
                              <Markdown>{selectedVideo.summary}</Markdown>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full bg-white border border-[#E5E5E5] rounded-2xl shadow-sm flex flex-col items-center justify-center text-[#999] space-y-4">
                  <MonitorPlay size={64} className="opacity-10" />
                  <p className="text-sm">Select a video from the queue to view details</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-8">
            <section className="bg-white border border-[#E5E5E5] rounded-2xl p-8 shadow-sm">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-12 h-12 bg-black rounded-xl flex items-center justify-center">
                  <Code className="text-white w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">Extension Setup Guide</h2>
                  <p className="text-[#666]">Follow these steps to enable transcript extraction.</p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-[#F5F5F5] rounded-full flex items-center justify-center font-bold text-sm shrink-0">1</div>
                  <div>
                    <h3 className="font-bold mb-2">Create a local folder</h3>
                    <p className="text-sm text-[#666]">Create a new folder on your computer named <code className="bg-[#F5F5F5] px-1.5 py-0.5 rounded">tubescript-extension</code>.</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-[#F5F5F5] rounded-full flex items-center justify-center font-bold text-sm shrink-0">2</div>
                  <div className="flex-1">
                    <h3 className="font-bold mb-4">Create the files</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {Object.entries(EXTENSION_FILES).map(([filename, content]) => (
                        <div key={filename} className="bg-[#F9F9F9] border border-[#EEE] rounded-xl overflow-hidden">
                          <div className="px-4 py-2 bg-[#F0F0F0] border-b border-[#EEE] flex items-center justify-between">
                            <span className="text-xs font-mono font-bold">{filename}</span>
                            <button 
                              onClick={() => {
                                navigator.clipboard.writeText(content);
                                showNotification(`${filename} copied!`, 'success');
                              }}
                              className="text-[#999] hover:text-black transition-colors"
                            >
                              <Copy size={14} />
                            </button>
                          </div>
                          <pre className="p-4 text-[10px] font-mono overflow-x-auto max-h-40 text-[#666]">
                            {content}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-[#F5F5F5] rounded-full flex items-center justify-center font-bold text-sm shrink-0">3</div>
                  <div>
                    <h3 className="font-bold mb-2">Load in Chrome</h3>
                    <p className="text-sm text-[#666] leading-relaxed">
                      Open <code className="bg-[#F5F5F5] px-1.5 py-0.5 rounded">chrome://extensions</code> in your browser. <br />
                      Enable <strong>Developer mode</strong> (toggle in top right). <br />
                      Click <strong>Load unpacked</strong> and select your folder.
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-[#F5F5F5] rounded-full flex items-center justify-center font-bold text-sm shrink-0">4</div>
                  <div>
                    <h3 className="font-bold mb-2">Refresh Dashboard</h3>
                    <p className="text-sm text-[#666]">Once loaded, refresh this page. The "Extension Status" indicator in the header should turn green.</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="bg-amber-50 border border-amber-200 rounded-2xl p-6 flex gap-4">
              <AlertCircle className="text-amber-600 shrink-0" />
              <div>
                <h4 className="font-bold text-amber-900 mb-1">Why do I need an extension?</h4>
                <p className="text-sm text-amber-800 leading-relaxed">
                  YouTube protects its transcripts from being scraped by standard web servers. 
                  A Chrome extension runs directly in your browser, allowing it to "see" what you see 
                  and reliably extract the transcript text that YouTube displays in its UI.
                </p>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Modals */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border ${
              notification.type === 'error' ? 'bg-red-50 border-red-100 text-red-600' : 
              notification.type === 'success' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 
              'bg-white border-[#E5E5E5] text-black'
            }`}
          >
            {notification.type === 'error' ? <AlertCircle size={18} /> : <Check size={18} />}
            <span className="text-sm font-medium">{notification.message}</span>
          </motion.div>
        )}

        {isDeleteModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDeleteModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8 text-center">
                <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
                  <Trash2 size={32} />
                </div>
                <h3 className="text-xl font-bold mb-2">Delete Videos?</h3>
                <p className="text-[#666] text-sm mb-8">
                  Are you sure you want to delete {selectedIds.size} selected videos? This action cannot be undone.
                </p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsDeleteModalOpen(false)}
                    className="flex-1 px-6 py-3 bg-[#F5F5F5] text-black rounded-xl font-medium hover:bg-[#EEEEEE] transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={confirmDelete}
                    className="flex-1 px-6 py-3 bg-red-600 text-white rounded-xl font-medium hover:bg-red-700 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {isAddModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAddModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-xl bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-[#F5F5F5] flex items-center justify-between">
                <h3 className="text-lg font-bold">Add YouTube Videos</h3>
                <button onClick={() => setIsAddModalOpen(false)} className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors">
                  <X size={20} />
                </button>
              </div>
              <div className="p-6">
                <p className="text-sm text-[#666] mb-4">Paste YouTube URLs below, one per line.</p>
                <textarea 
                  value={urls}
                  onChange={(e) => setUrls(e.target.value)}
                  placeholder="https://youtube.com/watch?v=...&#10;https://youtube.com/watch?v=..."
                  className="w-full h-48 p-4 bg-[#F9F9F9] border border-[#EEEEEE] rounded-2xl focus:outline-none focus:ring-2 focus:ring-black/5 resize-none text-sm font-mono"
                  autoFocus
                />
                <div className="mt-6 flex gap-3">
                  <button 
                    onClick={() => setIsAddModalOpen(false)}
                    className="flex-1 px-6 py-3 bg-[#F5F5F5] text-black rounded-xl font-medium hover:bg-[#EEEEEE] transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => { addUrls(); setIsAddModalOpen(false); }}
                    disabled={!urls.trim()}
                    className="flex-1 px-6 py-3 bg-black text-white rounded-xl font-medium hover:bg-zinc-800 transition-colors disabled:opacity-50"
                  >
                    Add to Queue
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {isStructureModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsStructureModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-[#F5F5F5] flex items-center justify-between">
                <h3 className="text-lg font-bold">Summary Structure</h3>
                <button onClick={() => setIsStructureModalOpen(false)} className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors">
                  <X size={20} />
                </button>
              </div>
              <div className="p-6">
                <p className="text-sm text-[#666] mb-4">Customize the structure of the summary. The system instructions remain fixed for quality.</p>
                <textarea 
                  value={summaryStructure}
                  onChange={(e) => setSummaryStructure(e.target.value)}
                  className="w-full h-64 p-4 bg-[#F9F9F9] border border-[#EEEEEE] rounded-2xl focus:outline-none focus:ring-2 focus:ring-black/5 resize-none text-sm font-mono leading-relaxed"
                />
                <div className="mt-6 flex gap-3">
                  <button 
                    onClick={() => setSummaryStructure(DEFAULT_SUMMARY_STRUCTURE)}
                    className="px-6 py-3 bg-white border border-[#E5E5E5] text-black rounded-xl font-medium hover:bg-[#F5F5F5] transition-colors flex items-center gap-2"
                  >
                    <RotateCcw size={16} /> Reset to Default
                  </button>
                  <div className="flex-1" />
                  <button 
                    onClick={() => setIsStructureModalOpen(false)}
                    className="px-8 py-3 bg-black text-white rounded-xl font-medium hover:bg-zinc-800 transition-colors"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
