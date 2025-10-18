/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import { generateEditedImage, generateFilteredImage, generateAdjustedImage, generateUpscaledImage, generateRetouchedFace, generateRestoredImage, generateRemovedBackground, generateBackgroundImage, generateZoomedImage, analyzeImageForSuggestions, SuggestionAnalysis, generateColorGradedImage, generateSharpenedImage, generateCorrectedOrientation, generateGrainImage, generateRotatedImage, type Face } from './services/geminiService';
import { saveImageToHistoryDB, getAllHistoryImagesDB, clearHistoryDB, removeImagesFromHistoryDB } from './services/sessionDb';
import Header from './components/Header';
import Spinner from './components/Spinner';
import FilterPanel from './components/FilterPanel';
import AdjustmentPanel from './components/AdjustmentPanel';
import CropPanel from './components/CropPanel';
import UpscalePanel from './components/UpscalePanel';
import FaceRetouchPanel from './components/FaceRetouchPanel';
import RestorePanel from './components/RestorePanel';
import WatermarkPanel, { type WatermarkSettings } from './components/WatermarkPanel';
import BackgroundPanel, { type BackgroundSettings } from './components/BackgroundPanel';
import OverlayPanel, { type OverlayLayer } from './components/OverlayPanel';
import ZoomPanel from './components/ZoomPanel';
import { UndoIcon, RedoIcon, EyeIcon, HistoryIcon, UserCircleIcon, PhotoIcon, SparklesIcon, SunIcon, EyeDropperIcon, ArrowUpOnSquareIcon, BullseyeIcon, PaletteIcon, MagicWandIcon, CropIcon, LayersIcon, MagnifyingGlassPlusIcon, WatermarkIcon, TuneIcon, MaskIcon } from './components/icons';
import StartScreen from './components/StartScreen';
import RestoreSessionModal from './components/RestoreSessionModal';
import DownloadModal, { type DownloadSettings } from './components/DownloadModal';
import HistoryPanel from './components/HistoryPanel';
import SuggestionPanel from './components/SuggestionPanel';
import ColorGradePanel from './components/ColorGradePanel';
import MaskEditor from './components/MaskEditor';


// Helper to convert a data URL string to a File object
const dataURLtoFile = (dataurl: string, filename: string): File => {
    const arr = dataurl.split(',');
    if (arr.length < 2) throw new Error("Invalid data URL");
    const mimeMatch = arr[0].match(/:(.*?);/);
    if (!mimeMatch || !mimeMatch[1]) throw new Error("Could not parse MIME type from data URL");

    const mime = mimeMatch[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type:mime});
}

// Helper to convert a File to a data URL string
const fileToDataURL = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
};

// Helper to convert a colored mask overlay into a black and white mask file for the API
const createBlackAndWhiteMask = (redOverlayUrl: string, width: number, height: number): Promise<File> => {
    return new Promise((resolve, reject) => {
        const maskImage = new Image();
        maskImage.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return reject(new Error('Could not get canvas context for mask generation.'));

            // Draw the red, semi-transparent overlay
            ctx.drawImage(maskImage, 0, 0, width, height);
            
            // Process pixels to create a pure black and white mask
            const imageData = ctx.getImageData(0, 0, width, height);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                // Check if the pixel has color (is not transparent)
                if (data[i + 3] > 0) { // Check alpha channel
                    data[i] = 255;     // R
                    data[i + 1] = 255; // G
                    data[i + 2] = 255; // B
                } else {
                    data[i] = 0;
                    data[i + 1] = 0;
                    data[i + 2] = 0;
                }
                // Alpha is kept
            }
            ctx.putImageData(imageData, 0, 0);

            canvas.toBlob((blob) => {
                if (!blob) return reject(new Error('Failed to create blob from mask canvas.'));
                const maskFile = new File([blob], 'mask.png', { type: 'image/png' });
                resolve(maskFile);
            }, 'image/png');
        };
        maskImage.onerror = (err) => reject(err);
        maskImage.src = redOverlayUrl;
    });
};


export type Tab = 'retouch' | 'face' | 'adjust' | 'filters' | 'colorGrade' | 'crop' | 'background' | 'overlay' | 'upscale' | 'zoom' | 'restore' | 'watermark' | 'mask';

export type Suggestion = {
  id: string;
  tab: Tab;
  title: string;
  description: string;
  icon: React.FC<{ className?: string }>;
};

// Define a library of all possible suggestions
const suggestionsLibrary: { [key: string]: Suggestion } = {
    // Technical Fixes
    restorePhoto: { id: 'restore', tab: 'restore', title: 'Restore Photo', description: 'Repair damage, fix fading, and improve clarity.', icon: SparklesIcon },
    upscaleSharpen: { id: 'upscale', tab: 'upscale', title: 'Upscale & Sharpen', description: 'Increase resolution and enhance sharpness.', icon: ArrowUpOnSquareIcon },
    improveLighting: { id: 'adjust-light', tab: 'adjust', title: 'Improve Lighting', description: 'Brighten the image and adjust the color temperature.', icon: SunIcon },
    
    // Portrait & People
    retouchFace: { id: 'face', tab: 'face', title: 'Retouch Face', description: 'Enhance portraits with professional facial retouching.', icon: UserCircleIcon },
    retouchFaces: { id: 'face-group', tab: 'face', title: 'Retouch Faces', description: 'Apply natural enhancements to faces in the group.', icon: UserCircleIcon },
    blurBackground: { id: 'adjust-blur-bg', tab: 'adjust', title: 'Blur Background', description: 'Create a professional "portrait mode" depth-of-field effect.', icon: BullseyeIcon },

    // Landscape & Scenery
    enhanceDetails: { id: 'adjust-details', tab: 'adjust', title: 'Enhance Details', description: 'Sharpen details and improve clarity for scenic shots.', icon: PhotoIcon },
    warmerLighting: { id: 'adjust-warm-light', tab: 'adjust', title: 'Add Warm Light', description: 'Give the photo a warm, "golden hour" feel.', icon: SunIcon },
    dramaticLook: { id: 'filter-dramatic', tab: 'filters', title: 'Apply Dramatic Filter', description: 'Add contrast and mood for a more powerful, cinematic look.', icon: PaletteIcon },

    // Color & Style
    boostVibrancy: { id: 'adjust-vibrancy', tab: 'adjust', title: 'Boost Color Vibrancy', description: 'Make the colors in your image pop.', icon: PaletteIcon },
    moodyColors: { id: 'filter-moody', tab: 'filters', title: 'Apply Moody Filter', description: 'Desaturate colors for a cinematic, moody feel.', icon: PaletteIcon },

    // Utility
    removeBackground: { id: 'background', tab: 'background', title: 'Remove Background', description: 'Isolate the main subject with a clean background removal.', icon: EyeDropperIcon },
};

const mapAnalysisToSuggestions = (analysis: SuggestionAnalysis): Suggestion[] => {
    const uniqueSuggestions = new Map<string, Suggestion>();
    
    const addSuggestion = (key: string) => {
        const suggestion = suggestionsLibrary[key];
        if (suggestion && !uniqueSuggestions.has(suggestion.id)) {
            uniqueSuggestions.set(suggestion.id, suggestion);
        }
    };

    // --- Rule-based suggestion logic ---

    // 1. Prioritize critical technical fixes
    if (analysis.characteristics.includes('damaged') || analysis.image_type === 'old_photo') {
        addSuggestion('restorePhoto');
    }
    if (analysis.characteristics.includes('blurry')) {
        addSuggestion('upscaleSharpen');
    }
    if (analysis.characteristics.includes('low_light')) {
        addSuggestion('improveLighting');
    }

    // 2. Suggestions based on image type
    switch (analysis.image_type) {
        case 'portrait':
            addSuggestion('retouchFace');
            addSuggestion('blurBackground');
            break;
        case 'group_photo':
            addSuggestion('retouchFaces');
            break;
        case 'landscape':
            addSuggestion('enhanceDetails');
            break;
        case 'product_shot':
            addSuggestion('removeBackground');
            break;
    }
    
    // 3. Contextual suggestions based on mood and characteristics
    const moodLower = analysis.mood.toLowerCase();

    if (analysis.characteristics.includes('muted_colors')) {
        addSuggestion('boostVibrancy');
    }

    if (analysis.image_type === 'landscape') {
        if (moodLower.includes('dramatic') || moodLower.includes('moody') || moodLower.includes('stormy')) {
            addSuggestion('dramaticLook');
        } else if (moodLower.includes('serene') || moodLower.includes('peaceful') || moodLower.includes('golden')) {
            addSuggestion('warmerLighting');
        }
    }
    
    if (analysis.image_type === 'portrait' && (moodLower.includes('happy') || moodLower.includes('joyful') || moodLower.includes('warm'))) {
        addSuggestion('warmerLighting');
    }

    if (moodLower.includes('moody') || moodLower.includes('dark') || moodLower.includes('somber') || moodLower.includes('cinematic')) {
        addSuggestion('moodyColors');
    }

    return Array.from(uniqueSuggestions.values());
};

const tools = [
  { id: 'retouch', label: 'Retouch', icon: MagicWandIcon },
  { id: 'mask', label: 'Mask', icon: MaskIcon },
  { id: 'face', label: 'Face', icon: UserCircleIcon },
  { id: 'adjust', label: 'Adjust', icon: SunIcon },
  { id: 'filters', label: 'Filters', icon: PaletteIcon },
  { id: 'colorGrade', label: 'Color Grade', icon: TuneIcon },
  { id: 'crop', label: 'Crop', icon: CropIcon },
  { id: 'background', label: 'Background', icon: EyeDropperIcon },
  { id: 'overlay', label: 'Overlay', icon: LayersIcon },
  { id: 'upscale', label: 'Upscale', icon: ArrowUpOnSquareIcon },
  { id: 'zoom', label: 'AI Zoom', icon: MagnifyingGlassPlusIcon },
  { id: 'restore', label: 'Restore', icon: SparklesIcon },
  { id: 'watermark', label: 'Watermark', icon: WatermarkIcon },
] as const;


const App: React.FC = () => {
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [prompt, setPrompt] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [editHotspot, setEditHotspot] = useState<{ x: number, y: number } | null>(null);
  const [displayHotspot, setDisplayHotspot] = useState<{ x: number, y: number } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('retouch');
  
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [aspect, setAspect] = useState<number | undefined>();
  const [rotation, setRotation] = useState(0);
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const [isLoadingSession, setIsLoadingSession] = useState<boolean>(true);
  const [sessionToRestore, setSessionToRestore] = useState<{ historyLength: number, historyIndex: number } | null>(null);
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState<boolean>(false);
  const [isBgRemovalMode, setIsBgRemovalMode] = useState<boolean>(false);
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState<boolean>(false);
  const [isWBPicking, setIsWBPicking] = useState<boolean>(false); // For White Balance Picker
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null);

  // State for multi-layer overlays
  const [overlayLayers, setOverlayLayers] = useState<OverlayLayer[]>([]);
  const [activeOverlayId, setActiveOverlayId] = useState<number | null>(null);

  // State for AI Suggestions
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  
  // State for Face Retouch
  const [detectedFaces, setDetectedFaces] = useState<Face[]>([]);
  const [selectedFaces, setSelectedFaces] = useState<Face[]>([]);


  // Check for saved session on initial load
  useEffect(() => {
    try {
        const savedSession = localStorage.getItem('utilpic-session');
        if (savedSession) {
            const parsed = JSON.parse(savedSession);
            if (typeof parsed.historyLength === 'number' && typeof parsed.historyIndex === 'number' && parsed.historyLength > 0) {
                setSessionToRestore({ historyLength: parsed.historyLength, historyIndex: parsed.historyIndex });
            }
        }
    } catch (e) {
        console.error("Failed to load session from localStorage", e);
        localStorage.removeItem('utilpic-session');
    } finally {
        setIsLoadingSession(false);
    }
  }, []);

  // Auto-save session to localStorage
  useEffect(() => {
    // Don't save while the restore prompt is active
    if (sessionToRestore || isLoadingSession) return;

    const saveSession = () => {
        if (history.length > 0) {
            try {
                const sessionData = {
                    historyLength: history.length,
                    historyIndex,
                };
                localStorage.setItem('utilpic-session', JSON.stringify(sessionData));
            } catch (e) {
                console.error("Failed to save session:", e);
            }
        } else {
            localStorage.removeItem('utilpic-session');
        }
    };

    saveSession();
  }, [history.length, historyIndex, sessionToRestore, isLoadingSession]);

  // Reset states based on active tab
  useEffect(() => {
    if (activeTab !== 'background') {
        setIsBgRemovalMode(false);
    }
    if (activeTab !== 'adjust') {
        setIsWBPicking(false);
    }
    if (activeTab === 'zoom') {
        setAspect(undefined); // AI Zoom is always freeform
    }
    if (activeTab !== 'face') {
        setDetectedFaces([]);
        setSelectedFaces([]);
    }
  }, [activeTab]);

  const currentImageUrl = history[historyIndex] ?? null;
  const originalImageUrl = history[0] ?? null;

  // Lazily create a File object from the current data URL only when needed for an API call.
  const currentImage = useMemo<File | null>(() => {
    if (!currentImageUrl) return null;
    return dataURLtoFile(currentImageUrl, `edit-${historyIndex}.png`);
  }, [currentImageUrl, historyIndex]);


  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const addImageToHistory = useCallback(async (newImageDataUrl: string) => {
    setShowSuggestions(false);
    const newHistory = history.slice(0, historyIndex + 1);
    const newHistoryIndex = newHistory.length;

    try {
      await removeImagesFromHistoryDB(newHistoryIndex); // Clear any "redo" states from DB
      await saveImageToHistoryDB(newHistoryIndex, newImageDataUrl);
    } catch (e) {
      console.error("Failed to save image to IndexedDB", e);
      setError("Could not save your edit. Your browser might be in private mode or storage is full.");
      return;
    }

    newHistory.push(newImageDataUrl);
    setHistory(newHistory);
    setHistoryIndex(newHistoryIndex);
    // Reset transient states after an action
    setCrop(undefined);
    setCompletedCrop(undefined);
    setOverlayLayers([]);
    setActiveOverlayId(null);
    setDetectedFaces([]);
    setSelectedFaces([]);
    setMaskDataUrl(null);
    setRotation(0);
  }, [history, historyIndex]);

  const handleImageUpload = useCallback(async (file: File) => {
    localStorage.removeItem('utilpic-session');
    await clearHistoryDB();
    setError(null);
    setIsLoading(true);
    setSuggestions([]);
    setShowSuggestions(false);

    try {
        const dataUrl = await fileToDataURL(file);
        await saveImageToHistoryDB(0, dataUrl);
        setHistory([dataUrl]);
        setHistoryIndex(0);
        setEditHotspot(null);
        setDisplayHotspot(null);
        setActiveTab('retouch');
        setCrop(undefined);
        setCompletedCrop(undefined);
        setIsBgRemovalMode(false);
        setOverlayLayers([]);
        setActiveOverlayId(null);
        setDetectedFaces([]);
        setSelectedFaces([]);
        setMaskDataUrl(null);
        setRotation(0);

        // Don't await this, let it run in the background
        analyzeImageForSuggestions(file).then(analysis => {
            console.log("Image analysis complete:", analysis);
            const newSuggestions = mapAnalysisToSuggestions(analysis);
            if (newSuggestions.length > 0) {
              setSuggestions(newSuggestions);
              setShowSuggestions(true);
            }
        }).catch(err => {
            // Log the error but don't show it to the user, it's not critical
            console.error("Failed to get AI suggestions:", err);
        });

    } catch(e) {
        console.error("Failed to load image", e);
        setError("There was a problem loading your image. Please try a different file.");
    } finally {
        setIsLoading(false);
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!currentImage) {
      setError('No image loaded to edit.');
      return;
    }
    
    if (!prompt.trim()) {
        setError('Please enter a description for your edit.');
        return;
    }

    if (!editHotspot && !maskDataUrl) {
        setError('Please click on the image to select an area to edit, or use the Mask tool for a more complex selection.');
        return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
        let maskFile: File | undefined = undefined;
        if (maskDataUrl && imgRef.current) {
            maskFile = await createBlackAndWhiteMask(maskDataUrl, imgRef.current.naturalWidth, imgRef.current.naturalHeight);
        }
        
        const editedImageUrl = await generateEditedImage(currentImage, prompt, editHotspot, maskFile);
        await addImageToHistory(editedImageUrl);
        setEditHotspot(null);
        setDisplayHotspot(null);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to generate the image. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, prompt, editHotspot, addImageToHistory, maskDataUrl]);
  
  const handleApplyFilter = useCallback(async (filterPrompt: string) => {
    if (!currentImage) {
      setError('No image loaded to apply a filter to.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
        const filteredImageUrl = await generateFilteredImage(currentImage, filterPrompt);
        await addImageToHistory(filteredImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply the filter. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyColorGrade = useCallback(async (gradePrompt: string) => {
    if (!currentImage) {
      setError('No image loaded to apply a color grade to.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
        const gradedImageUrl = await generateColorGradedImage(currentImage, gradePrompt);
        await addImageToHistory(gradedImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply the color grade. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);
  
  const handleApplyAdjustment = useCallback(async (adjustmentPrompt: string) => {
    if (!currentImage) {
      setError('No image loaded to apply an adjustment to.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
        const adjustedImageUrl = await generateAdjustedImage(currentImage, adjustmentPrompt);
        await addImageToHistory(adjustedImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply the adjustment. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplySharpen = useCallback(async (intensity: string) => {
    if (!currentImage) {
      setError('No image loaded to apply sharpening to.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
        const sharpenedImageUrl = await generateSharpenedImage(currentImage, intensity);
        await addImageToHistory(sharpenedImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply sharpening. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyGrain = useCallback(async (intensity: string) => {
    if (!currentImage) {
      setError('No image loaded to apply grain to.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
        const grainyImageUrl = await generateGrainImage(currentImage, intensity);
        await addImageToHistory(grainyImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply grain. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyAutoEnhance = useCallback(async () => {
    const autoEnhancePrompt = "Analyze the entire image and apply a balanced set of automatic adjustments to improve its overall quality. Enhance brightness, contrast, and color saturation for a natural and vibrant look. Subtly sharpen the image where needed. The result should be a clear, well-exposed, and photorealistic improvement.";
    await handleApplyAdjustment(autoEnhancePrompt);
  }, [handleApplyAdjustment]);

  const handleApplyFaceRetouch = useCallback(async (settings: { skinSmoothing: number; eyeBrightening: number; selectedFaces: Face[] }) => {
    if (!currentImage) {
      setError('No image loaded to apply retouching to.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
        const retouchedImageUrl = await generateRetouchedFace(currentImage, settings);
        await addImageToHistory(retouchedImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply face retouch. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyUpscale = useCallback(async (scale: number, detailIntensity: string) => {
    if (!currentImage) {
        setError('No image loaded to upscale.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const upscaledImageUrl = await generateUpscaledImage(currentImage, scale, detailIntensity);
        await addImageToHistory(upscaledImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to upscale the image. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyRestoration = useCallback(async () => {
    if (!currentImage) {
        setError('No image loaded to restore.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const restoredImageUrl = await generateRestoredImage(currentImage);
        await addImageToHistory(restoredImageUrl);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to restore the image. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyWatermark = useCallback(async (settings: WatermarkSettings) => {
    if (!currentImageUrl) {
        setError('No image loaded to apply a watermark to.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const image = new Image();
        
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = (err) => reject(err);
            image.src = currentImageUrl;
        });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not get canvas context.');
        }

        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        ctx.drawImage(image, 0, 0);

        // Set styles
        ctx.globalAlpha = settings.opacity;
        const margin = canvas.width * 0.02; // 2% margin

        // Draw watermark
        if (settings.type === 'text' && settings.text) {
            const fontSize = settings.fontSize * (canvas.width / 1000); // Scale font size relative to image width
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.fillStyle = settings.textColor;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';

            const textMetrics = ctx.measureText(settings.text);
            const textWidth = textMetrics.width;
            const textHeight = fontSize; // Approximate height

            let x = 0, y = 0;

            const pos = settings.position.split('-');
            if (pos[0] === 'top') y = margin + textHeight;
            else if (pos[0] === 'middle') y = canvas.height / 2 + textHeight / 2;
            else y = canvas.height - margin;

            if (pos[1] === 'left') x = margin;
            else if (pos[1] === 'center') x = (canvas.width - textWidth) / 2;
            else x = canvas.width - textWidth - margin;
            
            ctx.fillText(settings.text, x, y);

        } else if (settings.type === 'logo' && settings.logoFile) {
            const logo = new Image();
            const logoUrl = URL.createObjectURL(settings.logoFile);
            await new Promise<void>((resolve, reject) => {
                logo.onload = () => resolve();
                logo.onerror = (err) => reject(err);
                logo.src = logoUrl;
            });
            URL.revokeObjectURL(logoUrl);

            const logoWidth = canvas.width * (settings.logoSize / 100);
            const logoHeight = logo.height * (logoWidth / logo.width); // maintain aspect ratio

            let x = 0, y = 0;

            const pos = settings.position.split('-');
            if (pos[0] === 'top') y = margin;
            else if (pos[0] === 'middle') y = (canvas.height - logoHeight) / 2;
            else y = canvas.height - logoHeight - margin;

            if (pos[1] === 'left') x = margin;
            else if (pos[1] === 'center') x = (canvas.width - logoWidth) / 2;
            else x = canvas.width - logoWidth - margin;

            ctx.drawImage(logo, x, y, logoWidth, logoHeight);
        }
        
        const watermarkedDataUrl = canvas.toDataURL('image/png');
        await addImageToHistory(watermarkedDataUrl);

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply watermark. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImageUrl, addImageToHistory]);

  const handleRemoveBackground = useCallback(async () => {
    if (!currentImage) {
        setError('No image loaded to remove the background from.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const removedBgImageUrl = await generateRemovedBackground(currentImage);
        await addImageToHistory(removedBgImageUrl);
        setIsBgRemovalMode(true);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to remove the background. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyNewBackground = useCallback(async (settings: BackgroundSettings) => {
    if (!currentImageUrl) {
        setError('No image available to apply a background to.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const foreground = new Image();
        await new Promise<void>((resolve, reject) => {
            foreground.onload = () => resolve();
            foreground.onerror = (err) => reject(err);
            foreground.src = currentImageUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = foreground.naturalWidth;
        canvas.height = foreground.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not get canvas context.');
        }

        // Hoist variables to be accessible later for cleanup
        let backgroundImageUrl: string | null = null;
        let isObjectURL = false;

        // Step 1: Prepare the background
        if (settings.type === 'color') {
            ctx.fillStyle = settings.value;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else {
            if (settings.type === 'generate') {
                backgroundImageUrl = await generateBackgroundImage(settings.value, canvas.width, canvas.height);
            } else if (settings.type === 'image') {
                backgroundImageUrl = URL.createObjectURL(settings.value);
                isObjectURL = true;
            } else { // url
                try {
                    const response = await fetch(settings.value);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch image from URL (status: ${response.status})`);
                    }
                    const blob = await response.blob();
                    backgroundImageUrl = URL.createObjectURL(blob);
                    isObjectURL = true;
                } catch (fetchError) {
                    console.error("Error fetching image from URL:", fetchError);
                    throw new Error("Could not load the image from the provided URL. The server might be blocking the request (CORS policy). Please try a different URL or download the image and upload it directly.");
                }
            }

            if (!backgroundImageUrl) {
                throw new Error("Background image could not be loaded.");
            }

            const background = new Image();
            await new Promise<void>((resolve, reject) => {
                background.onload = () => resolve();
                background.onerror = (err) => reject(err);
                background.src = backgroundImageUrl!;
            });

            // Draw background image to fill canvas (cover)
            const canvasAspect = canvas.width / canvas.height;
            const bgAspect = background.naturalWidth / background.naturalHeight;
            let sx = 0, sy = 0, sWidth = background.naturalWidth, sHeight = background.naturalHeight;

            if (bgAspect > canvasAspect) { // Background is wider
                sWidth = background.naturalHeight * canvasAspect;
                sx = (background.naturalWidth - sWidth) / 2;
            } else { // Background is taller
                sHeight = background.naturalWidth / canvasAspect;
                sy = (background.naturalHeight - sHeight) / 2;
            }
            ctx.drawImage(background, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
        }

        // Step 2: Draw foreground over the background
        ctx.drawImage(foreground, 0, 0);
        
        // Step 3: Finalize and get the data URL. This forces all canvas operations to complete.
        const finalDataUrl = canvas.toDataURL('image/png');

        // Step 4: Now that the canvas is finalized, it's safe to revoke the temporary URL.
        if (isObjectURL && backgroundImageUrl) {
            URL.revokeObjectURL(backgroundImageUrl);
        }

        await addImageToHistory(finalDataUrl);
        setIsBgRemovalMode(false);

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply new background. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImageUrl, addImageToHistory]);

  const handleApplyAllOverlays = useCallback(async () => {
    if (!currentImageUrl || overlayLayers.length === 0) {
        setError('Please add at least one overlay layer to apply.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const baseImage = new Image();
        await new Promise<void>((resolve, reject) => {
            baseImage.onload = () => resolve();
            baseImage.onerror = (err) => reject(err);
            baseImage.src = currentImageUrl;
        });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not get canvas context.');
        }

        canvas.width = baseImage.naturalWidth;
        canvas.height = baseImage.naturalHeight;

        // 1. Draw base image
        ctx.drawImage(baseImage, 0, 0);

        // 2. Iterate and draw each visible overlay layer
        for (const layer of overlayLayers) {
            if (!layer.isVisible || !layer.overlayFile) continue;

            const overlayImage = new Image();
            // We use the previewUrl as it's an already created ObjectURL
            await new Promise<void>((resolve, reject) => {
                overlayImage.onload = () => resolve();
                overlayImage.onerror = (err) => reject(err);
                overlayImage.src = layer.previewUrl;
            });
            
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode;

            const overlayWidth = canvas.width * (layer.size / 100);
            const overlayHeight = overlayImage.height * (overlayWidth / overlayImage.width);

            const xPos = canvas.width * (layer.position.x / 100);
            const yPos = canvas.height * (layer.position.y / 100);

            ctx.drawImage(overlayImage, xPos, yPos, overlayWidth, overlayHeight);
        }
        
        // Reset canvas context properties
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0; 

        const finalDataUrl = canvas.toDataURL('image/png');
        await addImageToHistory(finalDataUrl);

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply overlays. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImageUrl, overlayLayers, addImageToHistory]);

  const handleAddNewOverlay = (file: File) => {
      const newLayer: OverlayLayer = {
        id: Date.now(),
        name: file.name,
        overlayFile: file,
        previewUrl: URL.createObjectURL(file),
        opacity: 0.7,
        size: 50,
        position: { x: 25, y: 25 },
        isVisible: true,
        blendMode: 'normal',
      };
      setOverlayLayers(prev => [...prev, newLayer]);
      setActiveOverlayId(newLayer.id);
  };

  const handleUpdateOverlay = (id: number, newSettings: Partial<OverlayLayer>) => {
      setOverlayLayers(prev => 
          prev.map(layer => layer.id === id ? { ...layer, ...newSettings } : layer)
      );
  };
  
  const handleDeleteOverlay = (id: number) => {
      const layerToDelete = overlayLayers.find(l => l.id === id);
      if (layerToDelete) {
          URL.revokeObjectURL(layerToDelete.previewUrl); // Clean up memory
      }
      setOverlayLayers(prev => prev.filter(layer => layer.id !== id));
      if (activeOverlayId === id) {
          setActiveOverlayId(null);
      }
  };

  const handleSelectOverlay = (id: number) => {
      setActiveOverlayId(id);
  };
  
  const handleToggleOverlayVisibility = (id: number) => {
      setOverlayLayers(prev => 
          prev.map(layer => 
              layer.id === id ? { ...layer, isVisible: !layer.isVisible } : layer
          )
      );
  };

  const handleReorderOverlays = (newLayers: OverlayLayer[]) => {
      setOverlayLayers(newLayers);
  };

  const handleApplyCropAndRotate = useCallback(async () => {
    const image = imgRef.current;
    if (!image) {
        setError('Image reference is not available.');
        return;
    }

    const cropToUse = (completedCrop?.width && completedCrop.height) 
      ? completedCrop 
      : {
          x: 0,
          y: 0,
          width: image.width, // Use client width as the base for the full image
          height: image.height,
          unit: 'px'
        } as PixelCrop;


    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
        setError('Could not process the crop.');
        return;
    }

    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const pixelRatio = window.devicePixelRatio || 1;

    canvas.width = Math.floor(cropToUse.width * scaleX * pixelRatio);
    canvas.height = Math.floor(cropToUse.height * scaleY * pixelRatio);

    ctx.scale(pixelRatio, pixelRatio);
    ctx.imageSmoothingQuality = 'high';

    const cropX = cropToUse.x * scaleX;
    const cropY = cropToUse.y * scaleY;

    const rotateRads = (rotation * Math.PI) / 180;
    const centerX = image.naturalWidth / 2;
    const centerY = image.naturalHeight / 2;

    ctx.save();
    
    // 1. Move the crop origin to the canvas origin (0,0)
    ctx.translate(-cropX, -cropY);
    // 2. Move the origin to the center of the original image
    ctx.translate(centerX, centerY);
    // 3. Rotate around the image's center
    ctx.rotate(rotateRads);
    // 4. Move the image's center back to the origin
    ctx.translate(-centerX, -centerY);
    
    // 5. Draw the rotated image
    ctx.drawImage(
      image,
      0,
      0,
      image.naturalWidth,
      image.naturalHeight
    );

    ctx.restore();
    
    const resultDataUrl = canvas.toDataURL('image/png');
    await addImageToHistory(resultDataUrl);

  }, [completedCrop, addImageToHistory, rotation]);

  const handleAutoRotate = useCallback(async () => {
    if (!currentImage) {
      setError('No image loaded to rotate.');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const rotatedImageUrl = await generateCorrectedOrientation(currentImage);
      await addImageToHistory(rotatedImageUrl);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setError(`Failed to auto-rotate the image. ${errorMessage}`);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);
  
  const handleRotateImage = useCallback(async (direction: 'clockwise' | 'counter-clockwise') => {
    if (!currentImage) {
      setError('No image loaded to rotate.');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const rotatedImageUrl = await generateRotatedImage(currentImage, direction);
      await addImageToHistory(rotatedImageUrl);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setError(`Failed to rotate the image. ${errorMessage}`);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);

  const handleApplyZoom = useCallback(async (zoomLevel: number, detailIntensity: string) => {
    if (!completedCrop || !imgRef.current) {
        setError('Please select an area to zoom into.');
        return;
    }

    setIsLoading(true);
    setError(null);

    try {
        const image = imgRef.current;
        const canvas = document.createElement('canvas');
        const scaleX = image.naturalWidth / image.width;
        const scaleY = image.naturalHeight / image.height;

        // Apply zoom level to the completedCrop
        const { x, y, width, height } = completedCrop;
        const zoomedWidth = width / zoomLevel;
        const zoomedHeight = height / zoomLevel;
        const zoomedX = x + (width - zoomedWidth) / 2;
        const zoomedY = y + (height - zoomedHeight) / 2;
        
        const sourceCropWidth = Math.round(zoomedWidth * scaleX);
        const sourceCropHeight = Math.round(zoomedHeight * scaleY);
        const sourceCropX = Math.round(zoomedX * scaleX);
        const sourceCropY = Math.round(zoomedY * scaleY);

        canvas.width = sourceCropWidth;
        canvas.height = sourceCropHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas context for cropping.');

        ctx.drawImage(
            image,
            sourceCropX,
            sourceCropY,
            sourceCropWidth,
            sourceCropHeight,
            0,
            0,
            sourceCropWidth,
            sourceCropHeight
        );

        const croppedBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!croppedBlob) throw new Error('Failed to create blob from cropped canvas.');

        const croppedFile = new File([croppedBlob], 'zoom-source.png', { type: 'image/png' });

        const targetWidth = image.naturalWidth;
        const targetHeight = image.naturalHeight;

        const zoomedImageUrl = await generateZoomedImage(croppedFile, targetWidth, targetHeight, detailIntensity);

        await addImageToHistory(zoomedImageUrl);

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply AI Zoom. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [completedCrop, addImageToHistory]);

  const handleUndo = useCallback(() => {
    if (canUndo) {
      setHistoryIndex(historyIndex - 1);
      setShowSuggestions(false);
      setEditHotspot(null);
      setDisplayHotspot(null);
      setIsBgRemovalMode(false);
      setOverlayLayers([]);
      setActiveOverlayId(null);
      setMaskDataUrl(null);
      setRotation(0);
    }
  }, [canUndo, historyIndex]);
  
  const handleRedo = useCallback(() => {
    if (canRedo) {
      setHistoryIndex(historyIndex + 1);
      setShowSuggestions(false);
      setEditHotspot(null);
      setDisplayHotspot(null);
      setIsBgRemovalMode(false);
      setOverlayLayers([]);
      setActiveOverlayId(null);
      setMaskDataUrl(null);
      setRotation(0);
    }
  }, [canRedo, historyIndex]);

  const handleReset = useCallback(() => {
    if (history.length > 0) {
      setHistoryIndex(0);
      setShowSuggestions(false);
      setError(null);
      setEditHotspot(null);
      setDisplayHotspot(null);
      setIsBgRemovalMode(false);
      setOverlayLayers([]);
      setActiveOverlayId(null);
      setMaskDataUrl(null);
      setRotation(0);
    }
  }, [history]);

    const handleHistorySelect = useCallback((index: number) => {
        if (index >= 0 && index < history.length) {
            setHistoryIndex(index);
            setShowSuggestions(false);
            setEditHotspot(null);
            setDisplayHotspot(null);
            setIsBgRemovalMode(false);
            setOverlayLayers([]);
            setActiveOverlayId(null);
            setCrop(undefined);
            setCompletedCrop(undefined);
            setMaskDataUrl(null);
            setRotation(0);
        }
    }, [history.length]);

  const handleUploadNew = useCallback(async () => {
      localStorage.removeItem('utilpic-session');
      await clearHistoryDB();
      setHistory([]);
      setHistoryIndex(-1);
      setError(null);
      setPrompt('');
      setShowSuggestions(false);
      setSuggestions([]);
      setEditHotspot(null);
      setDisplayHotspot(null);
      setIsBgRemovalMode(false);
      setOverlayLayers([]);
      setActiveOverlayId(null);
      setMaskDataUrl(null);
      setRotation(0);
  }, []);

  const handleDownload = useCallback(() => {
    if (currentImage) {
      setIsDownloadModalOpen(true);
    }
  }, [currentImage]);
  
  const handleConfirmDownload = useCallback(async (settings: DownloadSettings) => {
    if (!currentImageUrl) return;

    setIsLoading(true);
    try {
        const image = new Image();
        
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = (err) => reject(err);
            image.src = currentImageUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error("Could not create canvas context for download.");
        };
        ctx.drawImage(image, 0, 0);
        
        const quality = (settings.format === 'jpeg' || settings.format === 'webp') ? settings.quality / 100 : undefined;
        const mimeType = `image/${settings.format}`;
        
        const dataUrl = canvas.toDataURL(mimeType, quality);
        
        const link = document.createElement('a');
        link.href = dataUrl;
        
        const fileExtension = settings.format;
        const baseName = `utilpic-edit-${historyIndex}`;
        link.download = `${baseName}-utilpic-edited.${fileExtension}`;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to process image for download. ${errorMessage}`);
    } finally {
        setIsLoading(false);
        setIsDownloadModalOpen(false);
    }
  }, [currentImageUrl, historyIndex]);
  
  const handleFileSelect = (files: FileList | null) => {
    if (files && files[0]) {
      handleImageUpload(files[0]);
    }
  };

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img) return;

    const rect = img.getBoundingClientRect();

    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    
    const { naturalWidth, naturalHeight, clientWidth, clientHeight } = img;
    const scaleX = naturalWidth / clientWidth;
    const scaleY = naturalHeight / clientHeight;

    const originalX = Math.round(offsetX * scaleX);
    const originalY = Math.round(offsetY * scaleY);

    if (activeTab === 'retouch' && !maskDataUrl) {
        setDisplayHotspot({ x: offsetX, y: offsetY });
        setEditHotspot({ x: originalX, y: originalY });
        return;
    }

    if (isWBPicking) {
        const canvas = document.createElement('canvas');
        canvas.width = naturalWidth;
        canvas.height = naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            setError('Could not process image for color picking.');
            return;
        }
        ctx.drawImage(img, 0, 0, naturalWidth, naturalHeight);
        const pixelData = ctx.getImageData(originalX, originalY, 1, 1).data;
        const [r, g, b] = pixelData;
        
        const prompt = `Perform a precise white balance correction on the entire image. A color that should be neutral gray is currently showing as RGB(${r}, ${g}, ${b}). Adjust the overall color cast of the image to make this color a neutral gray, ensuring the correction is applied naturally across all tones.`;
        
        handleApplyAdjustment(prompt);
        setIsWBPicking(false); // Turn off picking mode after selection
    }
};

  const handleRestoreSession = async () => {
    if (sessionToRestore) {
        setIsLoading(true);
        setError(null);
        try {
            const historyImages = await getAllHistoryImagesDB(sessionToRestore.historyLength);
            if (historyImages.length !== sessionToRestore.historyLength) {
                throw new Error("Mismatch between session metadata and stored images. Session may be corrupt.");
            }
            setHistory(historyImages);
            setHistoryIndex(sessionToRestore.historyIndex);
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
            console.error("Failed to restore session files from IndexedDB:", e);
            setError(`Could not restore session. The saved data might be corrupted. ${errorMessage} Starting a new session.`);
            localStorage.removeItem('utilpic-session');
            await clearHistoryDB();
            setHistory([]);
            setHistoryIndex(-1);
        } finally {
            setSessionToRestore(null);
            setIsLoading(false);
        }
    }
  };

  const handleStartNewSession = async () => {
      localStorage.removeItem('utilpic-session');
      await clearHistoryDB();
      setSessionToRestore(null);
      setHistory([]);
      setHistoryIndex(-1);
  };
  
  const handleApplySuggestion = (tab: Tab) => {
    setActiveTab(tab);
    setShowSuggestions(false);
  };

  const handleApplyMask = useCallback((newMaskDataUrl: string) => {
    setMaskDataUrl(newMaskDataUrl);
    setActiveTab('retouch'); // Switch back to retouch to enter prompt
  }, []);


  const renderContent = () => {
    if (error) {
       return (
           <div className="text-center animate-fade-in bg-red-500/10 border border-red-500/20 p-8 rounded-lg max-w-2xl mx-auto flex flex-col items-center gap-4">
            <h2 className="text-2xl font-bold text-red-300">An Error Occurred</h2>
            <p className="text-md text-red-400">{error}</p>
            <button
                onClick={() => setError(null)}
                className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-6 rounded-lg text-md transition-colors"
              >
                Try Again
            </button>
          </div>
        );
    }
    
    if (!currentImageUrl) {
      return <StartScreen onFileSelect={handleFileSelect} />;
    }

    const imageDisplay = (
      <div className="relative">
        {/* Base image is the original, always at the bottom */}
        {originalImageUrl && (
            <img
                key={originalImageUrl}
                src={originalImageUrl}
                alt="Original"
                className="w-full h-auto object-contain max-h-[50vh] lg:max-h-[60vh] rounded-xl pointer-events-none"
                loading="lazy"
            />
        )}
        {/* The current image is an overlay that fades in/out for comparison */}
        <img
            ref={imgRef}
            key={currentImageUrl}
            src={currentImageUrl}
            alt="Current"
            onClick={handleImageClick}
            className={`absolute top-0 left-0 w-full h-auto object-contain max-h-[50vh] lg:max-h-[60vh] rounded-xl transition-opacity duration-200 ease-in-out animate-image-update ${isComparing ? 'opacity-0' : 'opacity-100'} ${activeTab === 'retouch' && !maskDataUrl || isWBPicking ? 'cursor-crosshair' : ''}`}
            loading="lazy"
        />
        {/* Mask Overlay */}
        {maskDataUrl && (
             <img
                src={maskDataUrl}
                alt="Active mask"
                className="absolute top-0 left-0 w-full h-auto object-contain max-h-[50vh] lg:max-h-[60vh] rounded-xl pointer-events-none"
            />
        )}
        {/* Face Detection Bounding Boxes */}
        {activeTab === 'face' && detectedFaces.length > 0 && imgRef.current && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
                {detectedFaces.map((face, index) => {
                    const isSelected = selectedFaces.some(sf => JSON.stringify(sf.box) === JSON.stringify(face.box));
                    const { x, y, width, height } = face.box;

                    return (
                        <div
                            key={index}
                            className={`absolute transition-all duration-200 border-2 rounded-md ${isSelected ? 'border-blue-400 bg-blue-400/20 shadow-lg' : 'border-white/50 border-dashed'}`}
                            style={{
                                left: `${x * 100}%`,
                                top: `${y * 100}%`,
                                width: `${width * 100}%`,
                                height: `${height * 100}%`,
                            }}
                        />
                    );
                })}
            </div>
        )}
        {/* Overlays Live Preview */}
        {activeTab === 'overlay' && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
              {overlayLayers.map(layer => {
                if (!layer.isVisible) return null;
                
                const styles: React.CSSProperties = {
                    position: 'absolute',
                    opacity: layer.opacity,
                    width: `${layer.size}%`,
                    height: 'auto',
                    top: `${layer.position.y}%`,
                    left: `${layer.position.x}%`,
                    mixBlendMode: layer.blendMode,
                };

                return (
                    <img
                        key={layer.id}
                        src={layer.previewUrl}
                        alt={layer.name}
                        style={styles}
                        className="pointer-events-none"
                    />
                );
              })}
            </div>
        )}
      </div>
    );
    
    // For ReactCrop, we need a single image element. We'll use the current one.
    const cropImageElement = (
      <img 
        ref={imgRef}
        key={`crop-${currentImageUrl}`}
        src={currentImageUrl} 
        alt="Crop this image"
        className="w-full h-auto object-contain max-h-[50vh] lg:max-h-[60vh] rounded-xl"
        loading="lazy"
      />
    );


    return (
      <div className="w-full flex flex-col lg:flex-row items-start gap-4 lg:gap-8 animate-fade-in">
        {/* Sidebar Navigation */}
        <nav className="flex flex-row lg:flex-col gap-1 bg-gray-800/80 border border-gray-700/80 rounded-lg p-2 backdrop-blur-sm lg:sticky top-24 lg:self-start w-full lg:w-auto overflow-x-auto">
            {tools.map(tool => (
                <button
                    key={tool.id}
                    onClick={() => setActiveTab(tool.id)}
                    className={`flex-shrink-0 flex items-center gap-3 font-semibold py-3 px-4 rounded-md transition-all duration-300 ease-out text-base text-left group origin-left transform hover:-translate-y-0.5 active:scale-[0.98] ${
                        activeTab === tool.id
                        ? 'bg-gradient-to-r from-blue-500 to-cyan-400 text-white shadow-lg shadow-cyan-500/30' 
                        : 'text-gray-300 hover:text-white hover:bg-white/10'
                    }`}
                >
                    <tool.icon className={`w-6 h-6 transition-all duration-300 ease-out ${activeTab === tool.id ? 'scale-110 text-white' : 'text-gray-400 group-hover:text-white group-hover:scale-110'}`} />
                    <span>{tool.label}</span>
                </button>
            ))}
        </nav>

        {/* Main Content Area */}
        <div className="flex-grow flex flex-col items-center gap-6 min-w-0 w-full">
            <div className={`relative w-full max-w-4xl shadow-2xl rounded-xl overflow-hidden bg-black/20 transition-all duration-500 ${isLoading ? 'animate-pulse-border animate-subtle-pulse' : ''}`}>
                {isLoading && (
                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 animate-fade-in animate-shimmer-bg">
                        <Spinner />
                        <p className="text-gray-300 animate-pulse-text">AI is working its magic...</p>
                    </div>
                )}
                
                {activeTab === 'crop' || activeTab === 'zoom' ? (
                <ReactCrop 
                    crop={crop} 
                    onChange={c => setCrop(c)} 
                    onComplete={c => setCompletedCrop(c)}
                    aspect={aspect}
                    rotate={rotation}
                    className="max-h-[50vh] lg:max-h-[60vh]"
                >
                    {cropImageElement}
                </ReactCrop>
                ) : imageDisplay }

                {displayHotspot && !isLoading && activeTab === 'retouch' && !maskDataUrl && (
                    <div 
                        className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2 z-10 animate-hotspot-appear"
                        style={{ left: `${displayHotspot.x}px`, top: `${displayHotspot.y}px` }}
                    >
                        <div className="relative flex justify-center items-center w-16 h-16">
                            {/* Outer ring */}
                            <div className="absolute w-full h-full rounded-full border-2 border-blue-400 animate-spin-slow"></div>
                            {/* Dashed ring */}
                            <div className="absolute w-[80%] h-[80%] rounded-full border-2 border-dashed border-white/50 animate-spin-reverse-slow"></div>
                            {/* Center dot with flare */}
                            <div className="relative inline-flex rounded-full h-3 w-3 bg-cyan-400 shadow-[0_0_10px_3px_rgba(56,189,248,0.7)]"></div>
                            {/* Crosshairs */}
                            <div className="absolute w-full h-px bg-blue-400/50"></div>
                            <div className="absolute h-full w-px bg-blue-400/50"></div>
                        </div>
                    </div>
                )}
            </div>
            
            {showSuggestions && suggestions.length > 0 && (
                <SuggestionPanel
                    suggestions={suggestions}
                    onApplySuggestion={handleApplySuggestion}
                    onDismiss={() => setShowSuggestions(false)}
                />
            )}

            <div className="w-full max-w-4xl grid">
                {/* Retouch Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'retouch' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                    <div className="flex flex-col items-center gap-4">
                        <p className="text-md text-gray-400">
                           {maskDataUrl ? 'A mask is active. Describe your edit for the selected area.' :
                           (editHotspot ? 'Great! Now describe your localized edit below.' : 'Click an area on the image to make a precise edit.')}
                        </p>
                        <form onSubmit={(e) => { e.preventDefault(); handleGenerate(); }} className="w-full flex flex-col sm:flex-row items-center gap-2">
                            <input
                                type="text"
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                placeholder={maskDataUrl ? "e.g., 'make this area glow'" : (editHotspot ? "e.g., 'change my shirt color to blue'" : "First click a point on the image")}
                                className="flex-grow bg-gray-800 border border-gray-700 text-gray-200 rounded-lg p-5 text-lg focus:ring-2 focus:ring-blue-500 focus:outline-none transition w-full disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isLoading || (!editHotspot && !maskDataUrl)}
                            />
                            {maskDataUrl && (
                                <button type="button" onClick={() => setMaskDataUrl(null)} className="text-sm bg-white/10 hover:bg-white/20 text-gray-200 font-semibold py-5 px-4 rounded-md transition-all active:scale-95 disabled:opacity-50">
                                    Clear Mask
                                </button>
                            )}
                            <button 
                                type="submit"
                                className="w-full sm:w-auto bg-gradient-to-br from-blue-600 to-blue-500 text-white font-bold py-5 px-8 text-lg rounded-lg transition-all duration-300 ease-in-out shadow-lg shadow-blue-500/20 hover:shadow-xl hover:shadow-blue-500/40 hover:-translate-y-px active:scale-95 active:shadow-inner disabled:from-blue-800 disabled:to-blue-700 disabled:shadow-none disabled:cursor-not-allowed disabled:transform-none"
                                disabled={isLoading || !prompt.trim() || (!editHotspot && !maskDataUrl)}
                            >
                                Generate
                            </button>
                        </form>
                    </div>
                </div>

                {/* Face Retouch Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'face' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <FaceRetouchPanel 
                    onApplyRetouch={handleApplyFaceRetouch} 
                    isLoading={isLoading}
                    currentImage={currentImage}
                    onFacesDetected={setDetectedFaces}
                    onFaceSelectionChange={setSelectedFaces}
                />
                </div>

                {/* Crop Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'crop' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <CropPanel 
                    onApply={handleApplyCropAndRotate} 
                    onSetAspect={setAspect} 
                    isLoading={isLoading} 
                    canApply={(!!completedCrop?.width && completedCrop.width > 0) || rotation !== 0}
                    onAutoRotate={handleAutoRotate} 
                    onRotateImage={handleRotateImage}
                    rotation={rotation}
                    onRotationChange={setRotation}
                />
                </div>

                {/* Adjust Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'adjust' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <AdjustmentPanel 
                    onApplyAdjustment={handleApplyAdjustment} 
                    onApplyAutoEnhance={handleApplyAutoEnhance}
                    onApplySharpen={handleApplySharpen}
                    onApplyGrain={handleApplyGrain}
                    isLoading={isLoading} 
                    onToggleWBPicker={() => setIsWBPicking(prev => !prev)}
                    isWBPicking={isWBPicking}
                />
                </div>
                
                {/* Filters Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'filters' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <FilterPanel onApplyFilter={handleApplyFilter} isLoading={isLoading} />
                </div>

                {/* Color Grade Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'colorGrade' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <ColorGradePanel onApplyColorGrade={handleApplyColorGrade} isLoading={isLoading} />
                </div>

                {/* Background Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'background' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <BackgroundPanel onRemoveBackground={handleRemoveBackground} onApplyNewBackground={handleApplyNewBackground} isLoading={isLoading} isBgRemovalMode={isBgRemovalMode} />
                </div>

                {/* Overlay Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'overlay' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <OverlayPanel 
                    layers={overlayLayers}
                    activeLayerId={activeOverlayId}
                    onAddLayer={handleAddNewOverlay}
                    onDeleteLayer={handleDeleteOverlay}
                    onUpdateLayer={handleUpdateOverlay}
                    onSelectLayer={handleSelectOverlay}
                    onToggleVisibility={handleToggleOverlayVisibility}
                    onReorderLayers={handleReorderOverlays}
                    onApplyAll={handleApplyAllOverlays}
                    isLoading={isLoading} 
                />
                </div>

                {/* Upscale Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'upscale' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <UpscalePanel onApplyUpscale={handleApplyUpscale} isLoading={isLoading} />
                </div>

                {/* Zoom Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'zoom' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <ZoomPanel
                    onApplyZoom={handleApplyZoom}
                    isLoading={isLoading}
                    isZooming={!!completedCrop?.width && completedCrop.width > 0}
                    completedCrop={completedCrop}
                    imageRef={imgRef}
                />
                </div>
                
                {/* Restore Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'restore' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <RestorePanel onApplyRestore={handleApplyRestoration} isLoading={isLoading} />
                </div>

                {/* Watermark Panel */}
                <div className={`col-start-1 row-start-1 transition-all duration-300 ease-out ${activeTab === 'watermark' ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-5 scale-[0.97] pointer-events-none'}`}>
                <WatermarkPanel onApplyWatermark={handleApplyWatermark} isLoading={isLoading} />
                </div>
            </div>
            
            <div className="w-full max-w-4xl flex flex-wrap items-center justify-center gap-2 sm:gap-3 mt-4 lg:mt-6">
                <button 
                    onClick={handleUndo}
                    disabled={!canUndo}
                    className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/5"
                    aria-label="Undo last action"
                >
                    <UndoIcon className="w-5 h-5 mr-2" />
                    Undo
                </button>
                <button 
                    onClick={handleRedo}
                    disabled={!canRedo}
                    className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/5"
                    aria-label="Redo last action"
                >
                    <RedoIcon className="w-5 h-5 mr-2" />
                    Redo
                </button>
                <button 
                    onClick={() => setIsHistoryPanelOpen(true)}
                    disabled={!canUndo}
                    className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/5"
                    aria-label="Show edit history"
                >
                    <HistoryIcon className="w-5 h-5 mr-2" />
                    History
                </button>
                
                <div className="h-6 w-px bg-gray-600 mx-1 hidden sm:block"></div>

                {canUndo && (
                <button 
                    onMouseDown={() => setIsComparing(true)}
                    onMouseUp={() => setIsComparing(false)}
                    onMouseLeave={() => setIsComparing(false)}
                    onTouchStart={() => setIsComparing(true)}
                    onTouchEnd={() => setIsComparing(false)}
                    className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base"
                    aria-label="Press and hold to see original image"
                >
                    <EyeIcon className="w-5 h-5 mr-2" />
                    Compare
                </button>
                )}

                <button 
                    onClick={handleReset}
                    disabled={!canUndo}
                    className="text-center bg-transparent border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/10 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent"
                >
                    Reset
                </button>
                <button 
                    onClick={handleUploadNew}
                    className="text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base"
                >
                    Upload New
                </button>

                <button 
                    onClick={handleDownload}
                    className="w-full sm:w-auto flex-grow sm:flex-grow-0 sm:ml-auto bg-gradient-to-br from-green-600 to-green-500 text-white font-bold py-3 px-5 rounded-md transition-all duration-300 ease-in-out shadow-lg shadow-green-500/20 hover:shadow-xl hover:shadow-green-500/40 hover:-translate-y-px active:scale-95 active:shadow-inner text-base"
                >
                    Download Image
                </button>
            </div>
        </div>
      </div>
    );
  };
  
  if (isLoadingSession) {
    return (
        <div className="min-h-screen text-gray-100 flex flex-col">
            <Header />
            <main className="flex-grow w-full flex items-center justify-center">
                <Spinner />
            </main>
        </div>
    );
  }

  return (
    <div className="min-h-screen text-gray-100 flex flex-col">
      {sessionToRestore && (
        <RestoreSessionModal 
            onRestore={handleRestoreSession} 
            onStartNew={handleStartNewSession} 
        />
      )}
      {isDownloadModalOpen && currentImage && (
        <DownloadModal 
            isOpen={isDownloadModalOpen}
            onClose={() => setIsDownloadModalOpen(false)}
            onConfirm={handleConfirmDownload}
            imageFile={currentImage}
        />
      )}
      {isHistoryPanelOpen && currentImageUrl && (
        <HistoryPanel
          history={history}
          currentIndex={historyIndex}
          onSelectHistory={handleHistorySelect}
          onClose={() => setIsHistoryPanelOpen(false)}
        />
      )}
      {currentImageUrl && (
        <MaskEditor
            isOpen={activeTab === 'mask'}
            onClose={() => setActiveTab('retouch')}
            onApplyMask={handleApplyMask}
            baseImageSrc={currentImageUrl}
        />
      )}
      <Header />
      <main className={`flex-grow w-full max-w-[1600px] mx-auto p-4 md:p-8 flex justify-center ${currentImageUrl ? 'items-start' : 'items-center'}`}>
        {!sessionToRestore && renderContent()}
      </main>
    </div>
  );
};

export default App;