"""Hardware prerequisite only: real local DDP/AllReduce, not Gear/Slime certification."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import time

import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel


def digest(model):
    result = hashlib.sha256()
    for name, value in model.state_dict().items():
        result.update(name.encode())
        result.update(value.detach().cpu().numpy().tobytes())
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rank, world = int(os.environ['RANK']), int(os.environ['WORLD_SIZE'])
    local = int(os.environ['LOCAL_RANK'])
    assert world == 2 and torch.cuda.device_count() == 2
    torch.set_num_threads(2)
    torch.cuda.set_device(local)
    device = torch.device('cuda', local)
    dist.init_process_group('nccl', timeout=datetime.timedelta(seconds=120), device_id=device)
    started = time.monotonic()
    values = torch.full((1024,), rank + 1., device=device)
    dist.all_reduce(values)
    assert torch.equal(values, torch.full_like(values, 3))
    torch.manual_seed(19)
    model = torch.nn.Sequential(torch.nn.Linear(128, 64), torch.nn.Tanh(), torch.nn.Linear(64, 16)).to(device)
    ddp = DistributedDataParallel(model, device_ids=[local])
    before = digest(model)
    optimizer = torch.optim.SGD(ddp.parameters(), lr=.1)
    generator = torch.Generator(device=device).manual_seed(100 + rank)
    inputs = torch.randn(32, 128, device=device, generator=generator)
    target = torch.ones(32, 16, device=device)
    losses = []
    for _ in range(5):
        optimizer.zero_grad(set_to_none=True)
        loss = torch.nn.functional.mse_loss(ddp(inputs), target)
        assert torch.isfinite(loss)
        loss.backward()
        optimizer.step()
        losses.append(loss.item())
    after = digest(model)
    hashes = [None] * world
    dist.all_gather_object(hashes, after)
    assert len(set(hashes)) == 1 and after != before
    assert losses[-1] < losses[0]
    report = {'kind': 'hardware-ddp-prerequisite', 'gear_training': False, 'status': 'passed',
              'world_size': world, 'rank': rank, 'pid': os.getpid(), 'gpu': torch.cuda.get_device_name(local),
              'initial_sha256': before, 'final_sha256': after, 'all_rank_hashes': hashes,
              'losses': losses, 'steps': len(losses), 'torch': torch.__version__, 'cuda': torch.version.cuda,
              'nccl': torch.cuda.nccl.version(), 'elapsed_seconds': time.monotonic() - started}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / f'rank{rank}.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    dist.destroy_process_group()


if __name__ == '__main__':
    main()
