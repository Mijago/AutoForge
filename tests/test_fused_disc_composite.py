"""composite_image_disc takes the fused Triton kernel on CUDA (nothing per
layer is kept at full output resolution): it must agree with the plain
PyTorch path, and keep the PyTorch path where a gradient is wanted."""
import pytest
import torch

from autoforge.Helper import FusedComposite as fc
from autoforge.Helper.OptimizerHelper import composite_image_disc, get_edge_bleed, set_edge_bleed

cuda_triton = pytest.mark.skipif(
    not (torch.cuda.is_available() and fc._HAS_TRITON), reason="needs CUDA + Triton"
)


@pytest.fixture(autouse=True)
def _restore_strength():
    before = get_edge_bleed()
    yield
    set_edge_bleed(before)


def _inputs(seed=3, H=41, W=33, L=12, M=4):
    g = torch.Generator().manual_seed(seed)
    dev = "cuda"
    pl = (torch.randn(H, W, generator=g) * 3).to(dev)
    gl = torch.randn(L, M, generator=g).to(dev)
    mc = torch.rand(M, 3, generator=g).to(dev)
    td = (torch.rand(M, generator=g) * 4 + 0.5).to(dev)
    bg = torch.rand(3, generator=g).to(dev)
    return pl, gl, mc, td, bg


def _disc(pl, gl, mc, td, bg, **kw):
    return composite_image_disc(pl, gl, 0.01, 0.01, 0.04, gl.shape[0], mc, td, bg, rng_seed=7, **kw)


@cuda_triton
@pytest.mark.parametrize("strength", [0.0, 0.25, 1.0])
def test_fused_matches_torch_path(monkeypatch, strength):
    set_edge_bleed(strength)
    inputs = _inputs()
    fused = _disc(*inputs)
    monkeypatch.setattr(fc, "_HAS_TRITON", False)
    ref = _disc(*inputs)
    assert torch.allclose(fused, ref, atol=0.1)


@cuda_triton
def test_matches_bf16_torch_path_to_its_precision(monkeypatch):
    """Callers pass compute_dtype=bf16 for the memory; the fused kernel is
    fp32 throughout, so it is the closer of the two to the fp32 result."""
    inputs = _inputs()
    fused = _disc(*inputs, compute_dtype=torch.bfloat16)
    monkeypatch.setattr(fc, "_HAS_TRITON", False)
    ref32 = _disc(*inputs)
    ref16 = _disc(*inputs, compute_dtype=torch.bfloat16)
    assert (fused - ref32).abs().max() <= (ref16 - ref32).abs().max() + 0.1


@cuda_triton
def test_gradient_to_the_materials_keeps_the_torch_path():
    pl, gl, mc, td, bg = _inputs()
    mc = mc.clone().requires_grad_(True)
    out = _disc(pl, gl, mc, td, bg)
    out.sum().backward()
    assert mc.grad is not None and torch.isfinite(mc.grad).all()
