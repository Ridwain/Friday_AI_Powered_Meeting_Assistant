"""Document parsing endpoints using LangChain loaders"""

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from typing import Optional
import tempfile
import os
import re
import zipfile
import xml.etree.ElementTree as ET

router = APIRouter()

@router.post("/parse-file")
async def parse_file(
    file: UploadFile = File(...),
    mimeType: str = Form(None)
):
    """Parse PDF, DOCX, or PPTX file and extract text"""
    
    content = await file.read()
    mime = mimeType or file.content_type or ""
    
    print(f"📄 Parsing file: {file.filename or 'uploaded'} ({mime})")
    
    text = ""
    
    try:
        if "pdf" in mime.lower():
            text = await parse_pdf(content)
        elif "presentation" in mime.lower() or "pptx" in mime.lower():
            text = await parse_pptx(content)
        elif "wordprocessing" in mime.lower() or "docx" in mime.lower():
            text = await parse_docx(content)
        else:
            # Try to read as plain text
            try:
                text = content.decode("utf-8", errors="ignore")
            except:
                text = "[Unable to parse file format]"
        
        # Clean up text
        text = re.sub(r'\s+', ' ', text).strip()
        
        print(f"✅ Parsed {len(text)} characters")
        return {"text": text, "length": len(text)}
        
    except Exception as e:
        print(f"❌ Parse error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to parse file: {str(e)}")


async def parse_pdf(content: bytes) -> str:
    """Parse PDF using pypdf"""
    from pypdf import PdfReader
    import io
    
    try:
        reader = PdfReader(io.BytesIO(content))
        text_parts = []
        
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
        
        text = "\n".join(text_parts)
        
        # If very little text, might be scanned PDF
        if len(text.strip()) < 100:
            return f"[PDF appears to be scanned or contains minimal text. Extracted: {text}]"
        
        return text
        
    except Exception as e:
        return f"[PDF parsing failed: {str(e)}]"


async def parse_pptx(content: bytes) -> str:
    """Parse PPTX using zipfile and XML parsing (same approach as Node.js)"""
    import io
    
    try:
        text_parts = []
        
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            # Get all slide files
            slide_files = sorted([
                f for f in zf.namelist() 
                if re.match(r'ppt/slides/slide\d+\.xml$', f)
            ], key=lambda x: int(re.search(r'slide(\d+)', x).group(1)))
            
            print(f"📑 Found {len(slide_files)} slides")
            
            for slide_file in slide_files:
                xml_content = zf.read(slide_file).decode('utf-8')
                # Extract text from <a:t> tags
                matches = re.findall(r'<a:t>([^<]*)</a:t>', xml_content)
                slide_text = ' '.join([m.strip() for m in matches if m.strip()])
                if slide_text:
                    text_parts.append(slide_text)
            
            # Also get notes
            notes_files = [f for f in zf.namelist() 
                         if re.match(r'ppt/notesSlides/notesSlide\d+\.xml$', f)]
            
            for notes_file in notes_files:
                xml_content = zf.read(notes_file).decode('utf-8')
                matches = re.findall(r'<a:t>([^<]*)</a:t>', xml_content)
                notes_text = ' '.join([m.strip() for m in matches if m.strip()])
                if notes_text:
                    text_parts.append(notes_text)
        
        print(f"📊 Extracted text from {len(slide_files)} slides, {len(notes_files)} notes")
        
        text = '\n\n'.join(text_parts)
        
        if not text.strip():
            return "[PPTX file appears to be empty or contains only images]"
        
        return text
        
    except Exception as e:
        return f"[PPTX parsing failed: {str(e)}]"


async def parse_docx(content: bytes) -> str:
    """Parse DOCX using python-docx"""
    from docx import Document
    import io
    
    try:
        doc = Document(io.BytesIO(content))
        text_parts = []
        
        for para in doc.paragraphs:
            if para.text.strip():
                text_parts.append(para.text)
        
        return '\n'.join(text_parts)
        
    except Exception as e:
        return f"[DOCX parsing failed: {str(e)}]"
