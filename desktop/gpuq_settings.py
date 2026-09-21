"""Use the same local Qwen paths as the machine-wide GPU coordinator."""
import json
import os
from pathlib import Path


def qwen_settings(config_path=None):
    root = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GpuQ'
    path = Path(config_path or os.environ.get('GPUQ_CONFIG', root / 'config.json'))
    values = json.loads(path.read_text(encoding='utf-8-sig')) if path.is_file() else {}
    values = {str(key).lower(): value for key, value in values.items()}
    defaults = {
        'qwenexecutable': r'D:\AI\llama.cpp\b10603\bin\llama-server.exe',
        'qwenworkingdirectory': r'D:\AI\llama.cpp\b10603',
        'qwenmodel': r'D:\AI\llama.cpp\models\Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf',
        'qwenvisionprojector': r'D:\AI\llama.cpp\models\mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf',
    }
    return {key: Path(values.get(key) or value) for key, value in defaults.items()}


def qwen_preflight(config_path=None):
    settings = qwen_settings(config_path)
    return {'available': all(settings[key].is_file() for key in ('qwenexecutable', 'qwenmodel', 'qwenvisionprojector')),
            'missing': [str(settings[key]) for key in ('qwenexecutable', 'qwenmodel', 'qwenvisionprojector') if not settings[key].is_file()]}
