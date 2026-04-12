#!/bin/bash
set -x

lsof -ti :12000
lsof -ti :12001
lsof -ti :12011
lsof -ti :3005
docker ps -a |grep codex
