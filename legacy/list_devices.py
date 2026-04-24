"""
list_devices.py

Run once before transcribe.py to confirm:
  - CUDA / GPU detected by ctranslate2
  - Default microphone and default speaker (what loopback will capture) are correct

Usage:
    python list_devices.py
"""
import os
import site
import sys


def _add_nvidia_dll_dirs() -> None:
    if sys.platform != "win32":
        return
    new_paths = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        nv = os.path.join(sp, "nvidia")
        if not os.path.isdir(nv):
            continue
        for sub in os.listdir(nv):
            bin_dir = os.path.join(nv, sub, "bin")
            if os.path.isdir(bin_dir):
                new_paths.append(bin_dir)
                if hasattr(os, "add_dll_directory"):
                    try:
                        os.add_dll_directory(bin_dir)
                    except (OSError, FileNotFoundError):
                        pass
    if new_paths:
        os.environ["PATH"] = os.pathsep.join(new_paths) + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()


def main():
    try:
        import soundcard as sc
    except ImportError:
        print("soundcard not installed. Run: pip install -r requirements.txt")
        sys.exit(1)

    print("=" * 78)
    print("Speakers  (loopback will capture whatever plays through the default one)")
    print("=" * 78)
    try:
        default_sp = sc.default_speaker()
    except Exception as e:
        default_sp = None
        print(f"  !! could not read default speaker: {e}")
    for sp in sc.all_speakers():
        tag = "  (default)" if default_sp and sp.name == default_sp.name else ""
        print(f"  - {sp.name}{tag}")

    print()
    print("=" * 78)
    print("Microphones")
    print("=" * 78)
    try:
        default_mic = sc.default_microphone()
    except Exception as e:
        default_mic = None
        print(f"  !! could not read default mic: {e}")
    for m in sc.all_microphones():
        tag = "  (default)" if default_mic and m.name == default_mic.name else ""
        print(f"  - {m.name}{tag}")

    print()
    print("=" * 78)
    print("Loopback sources available")
    print("=" * 78)
    for m in sc.all_microphones(include_loopback=True):
        if m.isloopback:
            print(f"  - {m.name}")

    print()
    print("-" * 78)
    print("CUDA check")
    print("-" * 78)
    try:
        import ctranslate2

        n = ctranslate2.get_cuda_device_count()
        if n > 0:
            print(f"  CUDA devices: {n} - GPU mode will work (large-v3 float16)")
        else:
            print("  CUDA devices: 0 - will fall back to CPU (medium int8, slower)")
            print("  Fix: check nvidia-smi works, install nvidia-cublas-cu12 + nvidia-cudnn-cu12")
    except ImportError:
        print("  faster-whisper not installed. Run: pip install -r requirements.txt")
    except Exception as e:
        print(f"  CUDA check error: {e}")

    print()
    print("If everything looks right, start the meeting with:  python transcribe.py")


if __name__ == "__main__":
    main()
